import { sendUpstream, upstreamUrl, type AdapterCall } from '../provider.js';

/**
 * Audio transcription — OpenAI-compatible /v1/audio/transcriptions (multipart).
 *
 * The client sends multipart/form-data with a `file` field + `model`. We forward
 * the raw body bytes verbatim with the original Content-Type boundary, only
 * ensuring `model` is set. (Most clients already include model; we don't parse
 * multipart here to avoid corrupting the boundary — passthrough is safest.)
 *
 * Response: { text } (JSON).
 *
 * NOTE: the `body` here is expected to be the raw multipart Buffer/string the
 * gateway captured, NOT a parsed JSON object. The gateway calls this adapter
 * with body = { __raw: <string|buffer>, __contentType: 'multipart/form-data;...' }.
 */
export async function transcribe(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'transcribe', model);
  const raw = body.__raw as string | Buffer | undefined;
  const contentType = body.__contentType as string | undefined;
  if (!raw || !contentType) {
    throw new Error('transcribe adapter expects { __raw, __contentType } — gateway must pass multipart body through');
  }
  return sendUpstream({ url, provider, body: raw as BodyInit, signal, contentType });
}
