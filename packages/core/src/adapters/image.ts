import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Image generation — OpenAI-compatible /v1/images/generations.
 *
 * Request:  { model, prompt, n?, size?, response_format?, quality?, style? }
 * Response: { created, data: [{ url } | { b64_json }] }
 *
 * Body is passed through with the model id injected; the gateway forwards the
 * JSON response verbatim.
 *
 * Kling AI quirk: Kling's image API expects the field `model_name`, not
 * `model`. When the provider's baseUrl or image endpoint contains 'klingai',
 * we rename `model` → `model_name` (drop the old `model` field) so the
 * OpenAI-compatible client can keep sending `model` while Kling gets what it
 * wants. This keeps the rename scoped to image + Kling only.
 */
export async function image(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'image', model);
  // Deteksi provider Kling: baseUrl atau endpoint image mengandung 'klingai'.
  const isKling = /klingai/i.test(provider.baseUrl) || /klingai/i.test(provider.endpoints.image ?? '');
  if (isKling) {
    const { model: _drop, ...rest } = body;
    return sendUpstream({ url, provider, body: JSON.stringify({ ...rest, model_name: model }), signal });
  }
  return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal });
}
