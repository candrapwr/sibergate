import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';
import { mapReasoning } from '../reasoning-mapper.js';

/** Chat completions — OpenAI-compatible /v1/chat/completions (JSON in, JSON/SSE out). */
export async function chat(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'chat', model);
  // Translate the client's `reasoning_effort` (OpenAI shape) into this target
  // provider's native thinking format (Anthropic thinking, Gemini thinkingConfig,
  // …). mapReasoning returns a fresh body — never mutates the shared `body`.
  const mapped = mapReasoning(body, provider.id, model);
  const upstreamBody = JSON.stringify({ ...mapped, model });
  const headers: Record<string, string> = {};
  if (body.stream) headers.Accept = 'text/event-stream';
  return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json', passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher });
}
