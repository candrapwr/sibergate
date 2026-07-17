import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Image generation — OpenAI-compatible /v1/images/generations.
 *
 * Request:  { model, prompt, n?, size?, response_format?, quality?, style? }
 * Response: { created, data: [{ url } | { b64_json }] }
 *
 * Body is passed through with the model id injected; the gateway forwards the
 * JSON response verbatim.
 */
export async function image(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'image', model);
  return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal });
}
