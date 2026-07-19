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
 */
export function convertChatRequestToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // Pisahkan system messages → instructions. Sisa role (user/assistant/tool)
  // masuk ke input. Bila ada beberapa system message, gabung dgn newline.
  const systemTexts: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const text = contentToString(m.content);
    if (role === 'system') {
      if (text) systemTexts.push(text);
    } else if (role === 'user' || role === 'assistant') {
      input.push({ role, content: text });
    } else if (role === 'tool') {
      // Hasil function call → masuk sebagai role 'user' dgn content (best-effort).
      // Responses API tidak punya role 'tool' seperti chat; ini perkiraan.
      input.push({ role: 'user', content: text });
    }
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
 * Handle output items tipe 'message' dgn content tipe 'output_text'.
 * Function_call / tool yg muncul di output diabaikan di scope awal (diteruskan
 * apa adanya di dalam message.content sebagai teks, best-effort).
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function convertResponsesToChat(json: Record<string, unknown>): ChatCompletionResponse {
  // output items array berisi pesan asisten + (mungkin) function_call.
  const output = Array.isArray(json.output) ? (json.output as any[]) : [];
  const textParts: string[] = [];
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') textParts.push(c.text);
      }
    }
  }
  const content = textParts.join('');

  // usage: input_tokens/output_tokens → prompt/completion.
  const u = (json.usage ?? {}) as Record<string, number>;
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = u.output_tokens ?? 0;

  // status: 'completed' → finish_reason 'stop'. Bila output ada function_call,
  // idealnya 'tool_calls', tapi scope awal tetap 'stop'.
  const finishReason = json.status === 'incomplete' ? 'length' : 'stop';

  return {
    id: typeof json.id === 'string' ? json.id : 'resp_unknown',
    object: 'chat.completion',
    created: typeof json.created_at === 'number' ? json.created_at : Math.floor(Date.now() / 1000),
    model: typeof json.model === 'string' ? json.model : '',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Convert satu event stream Responses API → 0 atau 1 chunk SSE chat/completions.
 * Mengembalikan:
 *   - {chunk}: kirim chunk chat ke client.
 *   - {chunk, usage}: chunk terakhir + usage utk log.
 *   - null: event di-skip (tidak relevan dgn format chat).
 *
 * Format event Responses (lihat SSE: `event: <type>\ndata: {...}\n\n`):
 *   - response.created           → skip (info)
 *   - response.in_progress       → skip
 *   - response.output_item.added → skip
 *   - response.output_text.delta → delta text → chat delta chunk
 *   - response.output_text.done  → skip (konten sudah di-stream per delta)
 *   - response.completed         → final chunk dgn usage + finish_reason
 *   - lainnya                    → skip
 */
export interface ConvertedChunk {
  /** Chunk SSE chat-completion utk dikirim ke client, atau null utk skip. */
  chunk: Record<string, unknown> | null;
  /** Usage info bila tersedia (dari event terminal). */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function convertResponsesStreamEventToChatChunk(
  eventType: string,
  payload: Record<string, unknown>,
  modelId: string,
): ConvertedChunk {
  // Helper utk bangun delta chunk standar.
  const deltaChunk = (delta: Record<string, unknown>) => ({
    id: typeof payload.response_id === 'string' ? payload.response_id : 'resp_stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: null }],
  });

  if (eventType === 'response.output_text.delta') {
    const delta = (payload as any).delta;
    if (typeof delta === 'string') return { chunk: deltaChunk({ content: delta }) };
    return { chunk: null };
  }

  if (eventType === 'response.completed') {
    // Event terminal. Ambil usage dari payload.response.usage.
    const resp = (payload as any).response ?? {};
    const u = resp.usage ?? {};
    const promptTokens = u.input_tokens ?? 0;
    const completionTokens = u.output_tokens ?? 0;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    return {
      chunk: {
        id: typeof resp.id === 'string' ? resp.id : 'resp_stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      },
      usage,
    };
  }

  // Event lain (created, in_progress, output_item.added, output_text.done, dll)
  // di-skip — tidak punya equivalent di chat SSE stream.
  return { chunk: null };
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
