import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * OpenAI Responses API adapter — /v1/responses.
 *
 * SiberGate client tetap memakai format chat/completions. Jika route target
 * punya modality 'responses', adapter ini meng-convert body chat → Responses
 * API saat dispatch ke upstream, dan gateway meng-convert balik response ke
 * format chat saat return ke client (lihat routes.ts & stream.ts di gateway).
 *
 * Yang di-convert (request, chat → responses):
 *   - messages[{role:'system'}]        → instructions
 *   - messages[{role:'user|assistant'}] → input: [{role, content}]
 *   - max_tokens                        → max_output_tokens
 *   - tools (function call OpenAI)     → tools (Responses format)
 *   - temperature, top_p, stream        → diteruskan apa adanya
 *
 * Yang TIDAK didukung scope awal:
 *   - Tools built-in Responses (web_search, file_search, computer_use) —
 *     tidak ada equivalent di chat/completions, di-skip.
 *   - previous_response_id (stateful conversation) — client kirim history
 *     messages seperti chat biasa.
 *
 * Lihat juga:
 *   - convertResponsesToChat: mapping response non-streaming (dipanggil gateway).
 *   - convertResponsesStreamEventToChatChunk: mapping SSE event (dipanggil
 *     stream.ts di gateway).
 */

/** Normalisasi 'content' message chat ke string (best-effort utk multimodal). */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Multimodal content: [{type:'text', text:'...'}, {type:'image_url', ...}].
    // Ambil semua bagian text, gabung. Bagian non-text diabaikan (di luar scope).
    return content
      .map((part: any) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * Convert body chat/completions → body Responses API. Pure function.
 * Tidak mengubah input; mengembalikan object baru.
 *
 * Termasuk multi-turn tool calling:
 *   - assistant message dgn `tool_calls` → Responses output item tipe
 *     'function_call' (dengan call_id dari tool_call.id).
 *   - tool message (hasil eksekusi, role='tool', content, tool_call_id) →
 *     Responses input item tipe 'function_call_output' (call_id + output).
 */
export function convertChatRequestToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // Pisahkan system messages → instructions. Sisa role masuk ke input items.
  // Bila ada beberapa system message, gabung dgn newline.
  const systemTexts: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const text = contentToString(m.content);

    if (role === 'system') {
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === 'user') {
      input.push({ role: 'user', content: text });
      continue;
    }
    if (role === 'assistant') {
      // Assistant bisa punya text content, tool_calls, atau keduanya.
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (text) input.push({ role: 'assistant', content: text });
      // Tiap tool_call chat → function_call Responses output item. Disisipkan
      // ke input sbg item tipe 'function_call' (Responses menerima itu di input
      // utk reconstruct conversation history).
      for (const tc of toolCalls as any[]) {
        if (tc?.type === 'function' && tc.function) {
          input.push({
            type: 'function_call',
            call_id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
          });
        }
      }
      continue;
    }
    if (role === 'tool') {
      // Hasil eksekusi tool → function_call_output Responses.
      input.push({
        type: 'function_call_output',
        call_id: typeof m.tool_call_id === 'string' ? m.tool_call_id : `call_${Math.random().toString(36).slice(2, 10)}`,
        output: text,
      });
      continue;
    }
    // Role lain (developer, function) → skip best-effort.
  }
  if (systemTexts.length) out.instructions = systemTexts.join('\n\n');
  out.input = input;

  // Field langsung diteruskan.
  if (typeof body.model === 'string') out.model = body.model;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stream === true) out.stream = true;

  // max_tokens → max_output_tokens.
  if (typeof body.max_tokens === 'number') out.max_output_tokens = body.max_tokens;

  // Tools: function calling OpenAI format → Responses format.
  // Chat:    [{type:'function', function:{name, description, parameters}}]
  // Responses: [{type:'function', name, description, parameters}]
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as any[])
      .filter((t) => t && t.type === 'function' && t.function)
      .map((t) => ({
        type: 'function',
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
      }));
  }

  // tool_choice: teruskan apa adanya bila string ('auto'/'none') atau object.
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;

  return out;
}

/**
 * Convert response JSON Responses API → format chat/completions. Pure function.
 *
 * Output items diperlaku-flex:
 *   - type 'message' dgn content 'output_text' → message.content (text).
 *   - type 'function_call' → message.tool_calls[i] {id: call_id, type:'function',
 *     function:{name, arguments}}. Bila ada minimal satu function_call,
 *     finish_reason = 'tool_calls' (OpenAI convention).
 */
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

export function convertResponsesToChat(json: Record<string, unknown>): ChatCompletionResponse {
  // output items array berisi pesan asisten + (mungkin) function_call.
  const output = Array.isArray(json.output) ? (json.output as any[]) : [];
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') textParts.push(c.text);
      }
    } else if (item.type === 'function_call') {
      // Responses function_call → chat tool_call. arguments adalah string JSON
      // di Responses (sudah serialized) — teruskan apa adanya sesuai spec OpenAI.
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  const content = textParts.length ? textParts.join('') : (toolCalls.length ? '' : '');
  // OpenAI: bila ada tool_calls, content boleh null. Kalau hanya text, content string.
  const messageContent: string | null = content || (toolCalls.length ? null : '');

  // usage: input_tokens/output_tokens → prompt/completion.
  const u = (json.usage ?? {}) as Record<string, number>;
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = u.output_tokens ?? 0;

  // finish_reason: 'tool_calls' bila function_call dipanggil, 'length' bila
  // status incomplete, selain itu 'stop'.
  let finishReason: string;
  if (toolCalls.length > 0) finishReason = 'tool_calls';
  else if (json.status === 'incomplete') finishReason = 'length';
  else finishReason = 'stop';

  const message: ChatCompletionResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: messageContent,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: typeof json.id === 'string' ? json.id : 'resp_unknown',
    object: 'chat.completion',
    created: typeof json.created_at === 'number' ? json.created_at : Math.floor(Date.now() / 1000),
    model: typeof json.model === 'string' ? json.model : '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Stateful converter utk streaming Responses API → chat/completions SSE chunks.
 *
 * Kenapa stateful? OpenAI Responses streaming mengirim function_call arguments
 * per-bagian dgn event `response.function_call_arguments.delta`, dan chat
 * streaming butuh `delta.tool_calls[i].function.arguments` (incremental string)
 * dgn `index` yg konsisten. Selain itu, `response.output_item.added` memberi
 * sinyal mulainya tool_call baru (utk set index). Maka converter harus track
 * output_index → tool_call index mapping sepanjang stream.
 *
 * Pakai: buat satu converter per stream (lihat gateway/stream.ts). Panggil
 * `processEvent(eventType, payload)` utk tiap event block. Return ConvertedChunk.
 */
export interface ConvertedChunk {
  /** Chunk SSE chat-completion utk dikirim ke client, atau null utk skip. */
  chunk: Record<string, unknown> | null;
  /** Usage info bila tersedia (dari event terminal). */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function createResponsesStreamConverter(modelId: string): {
  processEvent: (eventType: string, payload: Record<string, unknown>) => ConvertedChunk;
} {
  // Mapping output_index → tool_call index (chat delta pakai array index).
  const outputIndexToToolIndex = new Map<number, number>();
  let nextToolIndex = 0;
  // Akumulasi content text utk capture result.content (utk estimateTokens fallback).
  // Penanda apakah output_item.added terakhir menandakan function_call (supaya
  // event args.delta/args.done tahu tool index mana).
  let pendingFunctionCallIndex = -1;

  const baseChunk = (id: string, delta: Record<string, unknown>, finish_reason: string | null, usage?: ConvertedChunk['usage']) => ({
    id,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });

  function processEvent(eventType: string, payload: Record<string, unknown>): ConvertedChunk {
    // ID respons dipakai utk identitas chunk. Ambil dari payload.response_id,
    // payload.response.id, atau fallback default.
    const respId =
      (typeof (payload as any).response_id === 'string' && (payload as any).response_id) ||
      (typeof (payload as any).response?.id === 'string' && (payload as any).response.id) ||
      'resp_stream';

    // ── output_item.added: item baru di output. Bila function_call → assign
    //    tool_call index baru utk item ini, dan emit delta awal dgn nama.
    if (eventType === 'response.output_item.added') {
      const item = (payload as any).item;
      const outputIndex = typeof (payload as any).output_index === 'number' ? (payload as any).output_index : -1;
      if (item?.type === 'function_call') {
        const idx = nextToolIndex++;
        if (outputIndex >= 0) outputIndexToToolIndex.set(outputIndex, idx);
        pendingFunctionCallIndex = idx;
        return {
          chunk: baseChunk(respId, {
            role: 'assistant',
            tool_calls: [
              {
                index: idx,
                id: typeof item.call_id === 'string' ? item.call_id : `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: { name: item.name ?? '', arguments: '' },
              },
            ],
          }, null),
        };
      }
      return { chunk: null };
    }

    // ── function_call_arguments.delta: increment arguments string utk tool_call.
    if (eventType === 'response.function_call_arguments.delta') {
      const delta = (payload as any).delta;
      const outputIndex = typeof (payload as any).output_index === 'number' ? (payload as any).output_index : -1;
      const idx = outputIndex >= 0 ? outputIndexToToolIndex.get(outputIndex) : pendingFunctionCallIndex;
      if (typeof delta !== 'string' || idx === undefined || idx < 0) return { chunk: null };
      return {
        chunk: baseChunk(respId, {
          tool_calls: [{ index: idx, function: { arguments: delta } }],
        }, null),
      };
    }

    // ── function_call_arguments.done: skip (args sudah dikirim per delta).
    if (eventType === 'response.function_call_arguments.done') {
      return { chunk: null };
    }

    // ── output_text.delta: text content increment.
    if (eventType === 'response.output_text.delta') {
      const delta = (payload as any).delta;
      if (typeof delta !== 'string') return { chunk: null };
      return { chunk: baseChunk(respId, { content: delta }, null) };
    }

    // ── completed: terminal. Set finish_reason: 'tool_calls' bila ada tool_call,
    //    else 'stop'. Sertakan usage dari payload.response.usage.
    if (eventType === 'response.completed') {
      const resp = (payload as any).response ?? {};
      const u = resp.usage ?? {};
      const promptTokens = u.input_tokens ?? 0;
      const completionTokens = u.output_tokens ?? 0;
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      const finishReason = nextToolIndex > 0 ? 'tool_calls' : 'stop';
      return {
        chunk: baseChunk(respId, {}, finishReason, usage),
        usage,
      };
    }

    // Event lain (created, in_progress, output_text.done, dll) di-skip.
    return { chunk: null };
  }

  return { processEvent };
}

/** Adapter call: convert + kirim ke upstream, return Response mentah. */
export async function responses(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'responses', model);
  const converted = convertChatRequestToResponses(body);
  // Pastikan model upstream selalu di-set (sama seperti adapter chat).
  converted.model = model;
  const upstreamBody = JSON.stringify(converted);
  const headers: Record<string, string> = {};
  if (body.stream) headers.Accept = 'text/event-stream';
  return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json' });
}
