/**
 * `tools-text` modality — tool calling via XML-embedded text generation.
 *
 * Bypass native function calling (yg bermasalah di Gemini: atomic args, signature
 * requirement, extra_content leak). Konsep: gateway INJECT system prompt
 * mengajarkan model pattern `<tool_call><name>..</name><args>..</args></tool_call>`,
 * lalu model generate TEXT (yg di-stream token-by-token → chunk parsial args!).
 * Gateway parse XML itu → reconstruct ke format OpenAI tool_calls standar.
 *
 * Keuntungan:
 *   - Chunk parsial args (UX typing, spinner resolve progresif) — krn text gen
 *   - No signature/extra_content issue — bypass native function calling
 *   - Multi-turn robust — history jadi text flat, no signature round-trip
 *   - Generik — semua provider OpenAI-compat support (cuma butuh chat endpoint)
 *
 * Trade-off:
 *   - Tool selection prompt-based (bisa salah pilih, tapi teruji reliable)
 *   - Validation type per-tool hilang — gateway parse JSON apa adana
 *
 * Wire: reuse `endpoints.chat` (POST ke /v1/chat/completions dgn body modified).
 * Modality opt-in per route target — tidak nyenggol modality lain.
 */

import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';
import { mapReasoning } from '../reasoning-mapper.js';

/* ───────────────────────────── Types ───────────────────────────── */

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Hasil satu langkah stream converter — bisa 0 atau beberapa OpenAI chunk. */
export interface ConvertedChunk {
  chunk: Record<string, unknown> | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type ChatUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Normalize OpenAI-compatible usage plus Gemini/Google variants into the
 * OpenAI chat usage shape. Gemini can surface usage as usageMetadata /
 * usage_metadata with promptTokenCount and candidatesTokenCount.
 */
export function normalizeChatUsage(payload: unknown): ChatUsage | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  const usage = (root.usage ?? root.usage_metadata ?? root.usageMetadata ?? root) as Record<string, unknown>;
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = numberField(usage, [
    'prompt_tokens',
    'input_tokens',
    'promptTokenCount',
    'prompt_token_count',
    'inputTokenCount',
    'input_token_count',
  ]);
  const completionTokens = numberField(usage, [
    'completion_tokens',
    'output_tokens',
    'candidatesTokenCount',
    'candidates_token_count',
    'outputTokenCount',
    'output_token_count',
  ]);
  const totalTokens = numberField(usage, [
    'total_tokens',
    'totalTokenCount',
    'total_token_count',
  ]);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return null;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: totalTokens ?? prompt + completion,
  };
}

/* ────────────────────── Request converter (chat → tools-text) ────────────────────── */

/**
 * Bangun system prompt gateway-generated yg mengajarkan model pattern tool_call XML.
 * List tool + parameter di-derive dari body.tools[] (format OpenAI declarations).
 */
function buildToolSystemPrompt(tools: any[]): string {
  const lines = tools.map((t) => {
    const fn = t?.function ?? t;
    const name = fn?.name;
    if (!name) return null;
    const params = fn?.parameters?.properties ?? {};
    const required: string[] = fn?.parameters?.required ?? [];
    const paramStr = Object.entries(params)
      .map(([k, v]: [string, any]) => `${k}: ${v?.type ?? 'any'}${required.includes(k) ? '' : '?'}`)
      .join(', ');
    const desc = fn?.description ? ` — ${fn.description}` : '';
    return `- ${name}(${paramStr})${desc}`;
  }).filter(Boolean);
  return `# Tool calling
You have access to these tools:
${lines.join('\n')}

When you need to call a tool, output EXACTLY this format (no markdown fence, raw XML):
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg":"value"}</args>
</tool_call>

Rules:
- Put ONLY valid JSON in <args>. Match the tool's parameter names exactly.
- You may call multiple tools by emitting multiple <tool_call> blocks.
- If NO tool is needed, respond normally as text (without any <tool_call> tags).
- Do not wrap <tool_call> in code fences or quotes.
- CRITICAL JSON escaping inside <args>: every double-quote inside a string value
  MUST be written as \\" (backslash-quote), every backslash as \\\\ (double
  backslash), every newline as \\n (backslash-n, NEVER a literal line break).
  Example: <args>{"content":"<div class=\\"box\\">line1\\nline2</div>"}</args>`;
}

/** Flatten OpenAI multimodal content (array of {type,text} / {type,image_url}) ke string utk history. */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text' && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Convert OpenAI chat-completions body → body tools-text (chat request dgn system
 * prompt injected + history tool_calls/tool → text). Body dikirim ke endpoint chat
 * standar. Strip `tools` & `tool_choice` (tidak dikirim native).
 */
export function convertChatRequestToToolsText(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tools = Array.isArray(body.tools) ? (body.tools as any[]) : [];

  // Copy field generik (kecuali yg di-rewrite).
  for (const k of ['model', 'temperature', 'top_p', 'max_tokens', 'stream', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'user']) {
    if (body[k] !== undefined) out[k] = body[k];
  }

  // Inject system prompt tool ke AWAL messages. Append ke system client bila ada.
  const messages = Array.isArray(body.messages) ? [...(body.messages as any[])] : [];
  const toolSys = buildToolSystemPrompt(tools);
  if (messages.length > 0 && messages[0]?.role === 'system') {
    messages[0] = { ...messages[0], content: `${contentToString(messages[0].content)}\n\n${toolSys}` };
  } else {
    messages.unshift({ role: 'system', content: toolSys });
  }

  // Convert history: assistant tool_calls → <tool_call> XML; tool results → text.
  out.messages = messages.map((m) => {
    const role = m?.role;
    if (role === 'assistant') {
      const text = contentToString(m.content);
      const toolCalls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length === 0) {
        return { role: 'assistant', content: text };
      }
      // Render tiap tool_call sbg XML block.
      const xml = toolCalls
        .map((tc) => {
          const name = tc?.function?.name ?? tc?.name ?? '';
          const argsRaw = tc?.function?.arguments ?? tc?.arguments ?? '';
          const args = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? {});
          return `<tool_call>\n<name>${name}</name>\n<args>${args}</args>\n</tool_call>`;
        })
        .join('\n');
      return { role: 'assistant', content: text ? `${text}\n\n${xml}` : xml };
    }
    if (role === 'tool') {
      // Tool result → user message dgn marker.
      const name = m?.name ?? m?.tool_call_id ?? 'tool';
      const text = contentToString(m.content);
      return { role: 'user', content: `[TOOL_RESULT for ${name}]\n${text}` };
    }
    return m;
  });

  return out;
}

/* ────────────────────── Non-stream reverse converter ────────────────────── */

function randomCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Some models occasionally omit `</args>` or emit a corrupted closing tag before
 * `</tool_call>`. Trim only trailing closing tags after the JSON payload; this
 * keeps JSON content intact while preventing `}</tool_call>` from reaching the
 * client as function.arguments.
 */
function stripTrailingClosingTags(s: string): string {
  return s.replace(/(?:\s*<\/[^>]*>\s*)+$/g, '');
}

function trailingClosingTagSuffix(s: string): number {
  const complete = s.match(/(?:\s*<\/[^>]*>\s*)+$/);
  if (complete?.index !== undefined) return s.length - complete.index;

  // Hold an incomplete unknown closing tag split across chunks, e.g. `}</｜｜`.
  const lt = s.lastIndexOf('</');
  if (lt >= 0 && s.indexOf('>', lt) === -1) return s.length - lt;
  return 0;
}

function findTagOutsideJsonString(
  s: string,
  tag: string,
  state: { inString?: boolean; escaped?: boolean } = {},
): number {
  let inString = state.inString === true;
  let escaped = state.escaped === true;

  for (let i = 0; i <= s.length - tag.length; i++) {
    const ch = s[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        continue;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (s.startsWith(tag, i)) return i;
  }

  return -1;
}

function findAnyClosingTagOutsideJsonString(
  s: string,
  state: { inString?: boolean; escaped?: boolean } = {},
): number {
  let inString = state.inString === true;
  let escaped = state.escaped === true;

  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        continue;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '<' && s[i + 1] === '/') return i;
  }

  return -1;
}

function advanceJsonStringState(
  s: string,
  state: { inString: boolean; escaped: boolean },
): void {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (ch === '\\') {
        state.escaped = true;
        continue;
      }
      if (ch === '"') state.inString = false;
      continue;
    }
    if (ch === '"') state.inString = true;
  }
}

/**
 * Escape control characters (newline, tab, cr, dll) supaya valid sbg JSON string
 * value. Native function calling provider escape otomatis args JSON; tools-text
 * kita yg parse text XML harus escape sendiri. Tanpa ini, args berisi multiline
 * code/text → client error "Bad control character in string literal".
 *
 * Hanya escape control chars JSON-spec (line separator \u2028/\u2029 juga krn
 * beberapa parser JS reject). Quote & backslash SUDAH di-escape model saat
 * generate JSON di <args>, jadi jangan dobel-escape.
 */
function escapeArgsJson(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) out += '\\n';        // \n
    else if (c === 0x0d) out += '\\r';   // \r
    else if (c === 0x09) out += '\\t';   // \t
    else if (c === 0x08) out += '\\b';   // \b
    else if (c === 0x0c) out += '\\f';   // \f
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0'); // other ctrl
    else if (c === 0x2028) out += '\\u2028'; // JS line separator (parser strict reject)
    else if (c === 0x2029) out += '\\u2029'; // JS paragraph separator
    else out += s[i]!;
  }
  return out;
}

/**
 * Best-effort repair args JSON yg invalid krn model lupa escape quote/backslash
 * di dalam string value (common pd text generation, krn model tdk enforce JSON
 * syntax seketat native function calling). Dipakai di akhir assemble (stream
 * terminal / non-stream) — BUKAN per-chunk (tidak mungkin repair parsial).
 *
 * Strategi: walk char-by-char tracking apakah di dalam string value. Quote mentah
 * (") di dalam string (bukan escape valid) → escape jadi \". Ini conservative:
 * hanya fire bila JSON.parse awal gagal, supaya tidak corrupt JSON valid.
 *
 * Note: tidak 100% perfect (kasus ambigu), tapi menangkap mayoritas model-emit
 * bug. Kalau masih invalid, args dikirim apa adana — client validate sendiri.
 */
function repairArgsJson(args: string): string {
  // Cepat: kalau sudah valid, return apa adana.
  try { JSON.parse(args); return args; } catch { /* lanjut repair */ }
  let out = '';
  let inString = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true; // masuk string value
      continue;
    }
    // Di dalam string.
    if (ch === '\\') {
      // Backslash escape sequence — copy 2 char (backslash + next).
      out += ch;
      if (i + 1 < args.length) { out += args[i + 1]!; i++; }
      continue;
    }
    if (ch === '"') {
      // Kandidat: closing quote ATAU raw quote di tengah. Heuristik: kalau char
      // setelahnya (skip whitespace) adalah `,` `}` `]` atau end → closing quote;
      // selain itu (mis. huruf, `<`, dll) → raw quote, escape.
      let j = i + 1;
      while (j < args.length && (args[j] === ' ' || args[j] === '\t' || args[j] === '\n' || args[j] === '\r')) j++;
      const after = args[j];
      if (after === ',' || after === '}' || after === ']' || after === ':' || after === undefined) {
        // Closing quote.
        out += '"';
        inString = false;
      } else {
        // Raw quote di tengah string → escape.
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  try { JSON.parse(out); return out; } catch { return args; /* repair gagal, return asli */ }
}

/**
 * Parse text content (yg mungkin mengandung <tool_call> XML) → tool_calls[] OpenAI.
 * Return {toolCalls, text} — text = bagian di luar tag (mungkin kosong).
 * Arguments di-escape control chars (newline literal → \\n) supaya JSON valid.
 */
function parseToolCallText(content: string): { toolCalls: ChatToolCall[]; text: string } {
  const toolCalls: ChatToolCall[] = [];
  let text = '';
  let pos = 0;

  while (pos < content.length) {
    const start = content.indexOf('<tool_call>', pos);
    if (start < 0) {
      text += content.slice(pos);
      break;
    }

    text += content.slice(pos, start);
    const nameOpen = content.indexOf('<name>', start + '<tool_call>'.length);
    if (nameOpen < 0) {
      text += content.slice(start);
      break;
    }

    const nameClose = content.indexOf('</name>', nameOpen + '<name>'.length);
    if (nameClose < 0) {
      text += content.slice(start);
      break;
    }

    const argsOpen = content.indexOf('<args>', nameClose + '</name>'.length);
    if (argsOpen < 0) {
      text += content.slice(start);
      break;
    }

    const argsStart = argsOpen + '<args>'.length;
    const rest = content.slice(argsStart);
    const argsEnd = findTagOutsideJsonString(rest, '</args>');
    const toolEnd = findTagOutsideJsonString(rest, '</tool_call>');
    const anyClosingTag = findAnyClosingTagOutsideJsonString(rest);

    let argsCloseRel = -1;
    let blockEnd = -1;
    if (argsEnd >= 0 && (toolEnd < 0 || argsEnd < toolEnd)) {
      argsCloseRel = argsEnd;
      const afterArgs = argsStart + argsEnd + '</args>'.length;
      const close = content.indexOf('</tool_call>', afterArgs);
      blockEnd = close >= 0 ? close + '</tool_call>'.length : afterArgs;
    } else if (anyClosingTag >= 0 && (toolEnd < 0 || anyClosingTag < toolEnd)) {
      argsCloseRel = anyClosingTag;
      const close = content.indexOf('</tool_call>', argsStart + anyClosingTag);
      blockEnd = close >= 0 ? close + '</tool_call>'.length : argsStart + anyClosingTag;
    } else if (toolEnd >= 0) {
      argsCloseRel = toolEnd;
      blockEnd = argsStart + toolEnd + '</tool_call>'.length;
    }

    if (argsCloseRel < 0 || blockEnd < 0) {
      text += content.slice(start);
      break;
    }

    const name = content.slice(nameOpen + '<name>'.length, nameClose);
    const args = content.slice(argsStart, argsStart + argsCloseRel);
    toolCalls.push({
      id: randomCallId(),
      type: 'function',
      function: { name: name.trim(), arguments: repairArgsJson(escapeArgsJson(stripTrailingClosingTags(args.trim()))) },
    });
    pos = blockEnd;
  }

  return { toolCalls, text: text.trim() };
}

/** Convert non-streaming tools-text response (JSON chat completion) → OpenAI format. */
export function convertToolsTextToChat(json: any, modelId: string): ChatCompletionResponse {
  const choice = json?.choices?.[0] ?? {};
  const rawContent = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const { toolCalls, text } = parseToolCallText(rawContent);

  const message: ChatCompletionResponse['choices'][0]['message'] = { role: 'assistant', content: null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    // OpenAI convention: bila ada tool_calls, content boleh null. Tapi simpan text
    // bila ada (model kadang beri context sebelum tool call).
    message.content = text || null;
  } else {
    message.content = rawContent;
  }

  const usage = normalizeChatUsage(json);

  return {
    id: json?.id ?? `tt_${Math.random().toString(36).slice(2, 12)}`,
    object: 'chat.completion',
    created: json?.created ?? Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : (choice.finish_reason ?? 'stop'),
    }],
    ...(usage ? { usage } : {}),
  };
}

/* ────────────────── Stateful stream converter (XML → OpenAI chunks) ────────────────── */

/**
 * State machine utk stream: feed text delta token-by-token, emit OpenAI chunks.
 * State:
 *   - buffer: text belum ter-emit (menunggu tag complete)
 *   - phase: 'outside' (text biasa), 'in_name', 'in_args' (dalam tool_call)
 *   - currentName/currentIndex: tool call yg sedang dirakit
 *   - nextToolIndex: counter index tool_call OpenAI
 *
 * Emit logic:
 *   - Text di luar tag → delta.content
 *   - `<name>X</name>` selesai → emit delta header tool_calls[index] (id/type/name, args kosong)
 *   - `<args>...` → emit delta.tool_calls[index].function.arguments per potongan (CHUNK PARSIAL!)
 *   - `</args>` + `</tool_call>` → selesai, increment index
 *
 * Penting: tag bisa ter-split lintas chunk (mis. `<tool` + `_call>`). State machine
 * buffer sampai tag complete dgn strategi: simpan text sejak tag `<` mulai, cek pattern.
 */
export function createToolsTextStreamConverter(
  modelId: string,
  opts: { bufferToolArgs?: boolean } = {},
): {
  processChunk: (deltaText: string) => ConvertedChunk[];
} {
  const respId = `tt_${Math.random().toString(36).slice(2, 12)}`;
  let nextToolIndex = 0;

  const baseChunk = (delta: Record<string, unknown>, finish_reason: string | null, usage?: ConvertedChunk['usage']) => ({
    id: respId,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });

  // State machine: posisi parser dlm stream.
  // outside = antara tool_call (atau text biasa)
  // inside_tool = di dalam <tool_call>...</tool_call>
  // inside_name = di dalam <name>...</name>
  // inside_args = di dalam <args>...</args>
  type Phase = 'outside' | 'inside_tool' | 'inside_name' | 'inside_args';
  let phase: Phase = 'outside';
  let pendingName = '';
  let currentToolIndex = -1;
  let currentToolId = '';
  let bufferedArgs = '';
  // Buffer utk handle tag yg ter-split lintas chunk.
  let buffer = '';
  const argsStringState = { inString: false, escaped: false };

  const emitArgsChunk = (text: string) => {
    advanceJsonStringState(text, argsStringState);
    if (opts.bufferToolArgs) {
      bufferedArgs += text;
      return null;
    }
    return baseChunk({
      tool_calls: [{ index: currentToolIndex, function: { arguments: escapeArgsJson(text) } }],
    }, null);
  };

  const emitBufferedToolCall = () => {
    if (!opts.bufferToolArgs || currentToolIndex < 0 || !currentToolId) return null;
    const args = repairArgsJson(escapeArgsJson(stripTrailingClosingTags(bufferedArgs.trimEnd())));
    const chunk = baseChunk({
      role: 'assistant',
      tool_calls: [{
        index: currentToolIndex,
        id: currentToolId,
        type: 'function',
        function: { name: pendingName, arguments: args },
      }],
    }, null);
    currentToolIndex = -1;
    currentToolId = '';
    bufferedArgs = '';
    return chunk;
  };

  const splitTrailingWhitespaceOutsideArgsString = (text: string): { emit: string; hold: string } => {
    const m = text.match(/\s+$/);
    if (!m?.[0]) return { emit: text, hold: '' };
    const emit = text.slice(0, text.length - m[0].length);
    const stateAfterEmit = { ...argsStringState };
    advanceJsonStringState(emit, stateAfterEmit);
    if (stateAfterEmit.inString) return { emit: text, hold: '' };
    return { emit, hold: m[0] };
  };

  /**
   * Cek apakah `s` diakhiri prefix dari tag (mis. "<tool", "<na", "</ar"). Return
   * length prefix yg masih incomplete (perlu di-buffer tunggu chunk berikutnya).
   * Mis. s="hello <to" → return 4 (substring "<to" bisa jadi awal "<tool_call").
   * Return 0 bila tidak ada prefix tag incomplete.
   */
  function incompleteTagSuffix(s: string): number {
    // Cari '<' terakhir di luar tag (kita cuma di phase 'outside' atau 'inside_tool'/'inside_args').
    const lt = s.lastIndexOf('<');
    if (lt < 0) return 0;
    const tail = s.slice(lt);
    // Tag valid maks: </tool_call> (12), <tool_call> (11), <name> (6), </name> (7),
    // <args> (6), </args> (7). Cek apakah tail adalah prefix dari salah satunya.
    const tags = ['<tool_call>', '</tool_call>', '<name>', '</name>', '<args>', '</args>'];
    // Bila tail sudah complete (ada di tags), bukan incomplete → return 0.
    if (tags.includes(tail)) return 0;
    const isPrefix = tags.some((t) => t.startsWith(tail));
    return isPrefix ? tail.length : 0;
  }

  return {
    processChunk(deltaText: string): ConvertedChunk[] {
      const out: ConvertedChunk[] = [];
      buffer += deltaText;

      // Proses buffer selama ada progress. Loop krn satu chunk bisa trigger beberapa emit.
      // (mis. chunk "hello<tool_call><name>x</name>" → emit content + emit tool header).
      let progress = true;
      while (progress && buffer.length > 0) {
        progress = false;

        if (phase === 'outside') {
          // Cari awal <tool_call>. Text sebelumnya → delta.content.
          const idx = buffer.indexOf('<tool_call>');
          if (idx >= 0) {
            if (idx > 0) {
              const text = buffer.slice(0, idx);
              out.push({ chunk: baseChunk({ content: text }, null) });
            }
            buffer = buffer.slice(idx + '<tool_call>'.length);
            phase = 'inside_tool';
            progress = true;
            continue;
          }
          // Mungkin buffer berakhir dgn prefix incomplete "<tool...". Sisa buffer.
          const inc = incompleteTagSuffix(buffer);
          if (inc > 0 && inc < buffer.length) {
            // Emit text sebelum prefix, simpan prefix utk chunk berikutnya.
            const text = buffer.slice(0, buffer.length - inc);
            if (text) out.push({ chunk: baseChunk({ content: text }, null) });
            buffer = buffer.slice(buffer.length - inc);
          } else if (inc === 0) {
            // Tidak ada prefix tag → emit seluruh buffer sbg content.
            out.push({ chunk: baseChunk({ content: buffer }, null) });
            buffer = '';
          }
          continue;
        }

        if (phase === 'inside_tool') {
          // Di dalam <tool_call>. Bisa cari <name> (sebelum di-parse) ATAU
          // <args>/</tool_call> (setelah name di-parse). Cek keduanya berurutan.
          // Kasus 1: cari <name> (hanya relevan bila belum parse name utk tool ini).
          const nameStart = buffer.indexOf('<name>');
          const argsStart = buffer.indexOf('<args>');
          const toolEnd = buffer.indexOf('</tool_call>');
          // Prioritas: <name> dulu (utk tool baru), lalu <args>, lalu </tool_call>.
          if (nameStart >= 0 && (argsStart < 0 || nameStart < argsStart) && (toolEnd < 0 || nameStart < toolEnd)) {
            buffer = buffer.slice(nameStart + '<name>'.length);
            phase = 'inside_name';
            pendingName = '';
            progress = true;
            continue;
          }
          if (argsStart >= 0 && (toolEnd < 0 || argsStart < toolEnd)) {
            buffer = buffer.slice(argsStart + '<args>'.length);
            phase = 'inside_args';
            argsStringState.inString = false;
            argsStringState.escaped = false;
            progress = true;
            continue;
          }
          if (toolEnd >= 0) {
            // tool_call selesai (tanpa args / setelah args). Tutup tool.
            buffer = buffer.slice(toolEnd + '</tool_call>'.length);
            phase = 'outside';
            if (opts.bufferToolArgs) {
              const chunk = emitBufferedToolCall();
              if (chunk) out.push({ chunk });
            }
            progress = true;
            continue;
          }
          // Belum nemu tag apa pun — tunggu chunk berikutnya (buffer dipertahankan).
          break;
        }

        if (phase === 'inside_name') {
          const end = buffer.indexOf('</name>');
          if (end >= 0) {
            pendingName += buffer.slice(0, end);
            buffer = buffer.slice(end + '</name>'.length);
            // Emit tool_call header (id/type/name, args kosong) — mulai tool call baru.
            currentToolIndex = nextToolIndex++;
            currentToolId = randomCallId();
            bufferedArgs = '';
            if (!opts.bufferToolArgs) {
              out.push({
                chunk: baseChunk({
                  role: 'assistant',
                  tool_calls: [{
                    index: currentToolIndex,
                    id: currentToolId,
                    type: 'function',
                    function: { name: pendingName, arguments: '' },
                  }],
                }, null),
              });
            }
            phase = 'inside_tool';
            progress = true;
            continue;
          }
          // Belum nemu </name>, akumulasi buffer tunggu.
          break;
        }

        if (phase === 'inside_args') {
          const end = findTagOutsideJsonString(buffer, '</args>', argsStringState);
          const toolEnd = findTagOutsideJsonString(buffer, '</tool_call>', argsStringState);
          const anyClosingTag = findAnyClosingTagOutsideJsonString(buffer, argsStringState);
          if (end >= 0 && (toolEnd < 0 || end < toolEnd)) {
            // Emit sisa args sebelum </args>. Escape control chars supaya valid JSON.
            const tail = buffer.slice(0, end).trimEnd();
            if (tail) {
              const chunk = emitArgsChunk(tail);
              if (chunk) out.push({ chunk });
            }
            buffer = buffer.slice(end + '</args>'.length);
            phase = 'inside_tool';
            if (opts.bufferToolArgs) {
              const chunk = emitBufferedToolCall();
              if (chunk) out.push({ chunk });
            }
            progress = true;
            continue;
          }
          if (anyClosingTag >= 0 && (toolEnd < 0 || anyClosingTag < toolEnd)) {
            // Corrupted close like `</｜｜DSML｜｜>` before `</tool_call>`.
            const tagEnd = buffer.indexOf('>', anyClosingTag);
            if (tagEnd < 0) break;
            const tail = stripTrailingClosingTags(buffer.slice(0, anyClosingTag).trimEnd());
            if (tail) {
              const chunk = emitArgsChunk(tail);
              if (chunk) out.push({ chunk });
            }
            buffer = buffer.slice(tagEnd + 1);
            if (opts.bufferToolArgs) {
              const chunk = emitBufferedToolCall();
              if (chunk) out.push({ chunk });
            }
            progress = true;
            continue;
          }
          if (toolEnd >= 0) {
            // Model kadang lupa `</args>` dan langsung tutup `</tool_call>`.
            // Treat that as an implicit args close, trimming any corrupted
            // closing tag it inserted just before `</tool_call>`.
            const tail = stripTrailingClosingTags(buffer.slice(0, toolEnd).trimEnd());
            if (tail) {
              const chunk = emitArgsChunk(tail);
              if (chunk) out.push({ chunk });
            }
            buffer = buffer.slice(toolEnd + '</tool_call>'.length);
            phase = 'outside';
            if (opts.bufferToolArgs) {
              const chunk = emitBufferedToolCall();
              if (chunk) out.push({ chunk });
            }
            progress = true;
            continue;
          }
          // Belum nemu </args>. Emit args parsial TAPI simpan suffix yg mungkin prefix
          // dari "</args>" (mis. "</ar") utk hindari emit premature.
          const inc = incompleteTagSuffix(buffer);
          if (inc > 0 && inc < buffer.length) {
            const emit = buffer.slice(0, buffer.length - inc).replace(/\s+$/g, '');
            if (emit) {
              const chunk = emitArgsChunk(emit);
              if (chunk) out.push({ chunk });
            }
            buffer = buffer.slice(buffer.length - inc);
          } else if (inc === 0 && buffer.length > 0) {
            const closingTagSuffix = trailingClosingTagSuffix(buffer);
            if (closingTagSuffix > 0) {
              const emit = buffer.slice(0, buffer.length - closingTagSuffix);
              if (emit) {
                const chunk = emitArgsChunk(emit);
                if (chunk) out.push({ chunk });
              }
              buffer = buffer.slice(buffer.length - closingTagSuffix);
              break;
            }
            // Emit seluruh buffer (tdk ada prefix tag). Escape control chars.
            const { emit, hold } = splitTrailingWhitespaceOutsideArgsString(buffer);
            if (emit) {
              const chunk = emitArgsChunk(emit);
              if (chunk) out.push({ chunk });
            }
            buffer = hold;
          }
          break;
        }
      }

      return out;
    },
  };
}

/* ───────────────────────────── Adapter ───────────────────────────── */

/** Adapter: convert chat request → tools-text, POST ke endpoint chat upstream. */
export async function toolsText(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  // Reuse endpoint chat (modality ini cuma butuh /v1/chat/completions standar).
  const url = upstreamUrl(provider, 'chat', model);
  const converted = convertChatRequestToToolsText(body);
  converted.model = model;
  if (provider.id === 'gemini' && body.stream === true) {
    const streamOptions = converted.stream_options && typeof converted.stream_options === 'object'
      ? converted.stream_options as Record<string, unknown>
      : {};
    converted.stream_options = { ...streamOptions, include_usage: true };
  }
  // Map reasoning intent ke native provider. Fresh object — tidak mutate body.
  const mapped = mapReasoning(converted as Record<string, unknown>, provider.id, model);
  const upstreamBody = JSON.stringify(mapped);
  const headers: Record<string, string> = {};
  if (body.stream) headers.Accept = 'text/event-stream';
  return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json', passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
}
