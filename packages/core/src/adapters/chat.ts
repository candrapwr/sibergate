import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/** Chat completions — OpenAI-compatible /v1/chat/completions (JSON in, JSON/SSE out). */
export async function chat(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'chat', model);
  const upstreamBody = JSON.stringify({ ...body, model });
  const headers: Record<string, string> = {};
  if (body.stream) headers.Accept = 'text/event-stream';
  return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json' });
}
