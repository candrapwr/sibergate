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
- Do not wrap <tool_call> in code fences or quotes.`;
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

const TOOL_CALL_RE = /<tool_call>\s*<name>([\s\S]*?)<\/name>\s*<args>([\s\S]*?)<\/args>\s*<\/tool_call>/g;

function randomCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Parse text content (yg mungkin mengandung <tool_call> XML) → tool_calls[] OpenAI.
 * Return {toolCalls, text} — text = bagian di luar tag (mungkin kosong).
 */
function parseToolCallText(content: string): { toolCalls: ChatToolCall[]; text: string } {
  const toolCalls: ChatToolCall[] = [];
  let text = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(content)) !== null) {
    text += content.slice(lastIdx, m.index);
    toolCalls.push({
      id: randomCallId(),
      type: 'function',
      function: { name: (m[1] ?? '').trim(), arguments: (m[2] ?? '').trim() },
    });
    lastIdx = m.index + m[0].length;
  }
  text += content.slice(lastIdx);
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

  const u = json?.usage ?? {};
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: u.total_tokens ?? promptTokens + completionTokens };

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
    ...(promptTokens || completionTokens ? { usage } : {}),
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
export function createToolsTextStreamConverter(modelId: string): {
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
  // Buffer utk handle tag yg ter-split lintas chunk.
  let buffer = '';

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
            progress = true;
            continue;
          }
          if (toolEnd >= 0) {
            // tool_call selesai (tanpa args / setelah args). Tutup tool.
            buffer = buffer.slice(toolEnd + '</tool_call>'.length);
            phase = 'outside';
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
            out.push({
              chunk: baseChunk({
                role: 'assistant',
                tool_calls: [{
                  index: currentToolIndex,
                  id: randomCallId(),
                  type: 'function',
                  function: { name: pendingName, arguments: '' },
                }],
              }, null),
            });
            phase = 'inside_tool';
            progress = true;
            continue;
          }
          // Belum nemu </name>, akumulasi buffer tunggu.
          break;
        }

        if (phase === 'inside_args') {
          const end = buffer.indexOf('</args>');
          if (end >= 0) {
            // Emit sisa args sebelum </args>.
            const tail = buffer.slice(0, end);
            if (tail) {
              out.push({
                chunk: baseChunk({
                  tool_calls: [{ index: currentToolIndex, function: { arguments: tail } }],
                }, null),
              });
            }
            buffer = buffer.slice(end + '</args>'.length);
            phase = 'inside_tool';
            progress = true;
            continue;
          }
          // Belum nemu </args>. Emit args parsial TAPI simpan suffix yg mungkin prefix
          // dari "</args>" (mis. "</ar") utk hindari emit premature.
          const inc = incompleteTagSuffix(buffer);
          if (inc > 0 && inc < buffer.length) {
            const emit = buffer.slice(0, buffer.length - inc);
            if (emit) {
              out.push({
                chunk: baseChunk({
                  tool_calls: [{ index: currentToolIndex, function: { arguments: emit } }],
                }, null),
              });
            }
            buffer = buffer.slice(buffer.length - inc);
          } else if (inc === 0 && buffer.length > 0) {
            // Emit seluruh buffer (tdk ada prefix tag).
            out.push({
              chunk: baseChunk({
                tool_calls: [{ index: currentToolIndex, function: { arguments: buffer } }],
              }, null),
            });
            buffer = '';
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
  const upstreamBody = JSON.stringify(converted);
  const headers: Record<string, string> = {};
  if (body.stream) headers.Accept = 'text/event-stream';
  return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json' });
}
