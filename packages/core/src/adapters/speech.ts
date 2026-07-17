import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Text-to-speech — OpenAI-compatible /v1/audio/speech.
 *
 * Request:  { model, input, voice, response_format?, speed? }
 * Response: binary audio (audio/mpeg by default) — NOT JSON.
 *
 * The gateway forwards the upstream binary stream + Content-Type verbatim.
 */
export async function speech(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'speech', model);
  return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal });
}
