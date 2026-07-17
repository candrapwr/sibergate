import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Embeddings — OpenAI-compatible /v1/embeddings.
 *
 * Request:  { model, input, encoding_format?, dimensions? }
 * Response: { object:"list", data:[{ object:"embedding", embedding:number[], index }] , model, usage }
 *
 * `input` may be a string or array of strings.
 */
export async function embed(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'embed', model);
  return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal });
}
