import { sendUpstream, upstreamUrl, GatewayCallError, type AdapterCall } from '../provider.js';
import {
  mapSpeechInput,
  qwenSpeechAudioUrl,
  decodeQwenSpeechAudio,
  speechContentType,
} from '../speech-mapper.js';

/** Decode Buffer → ArrayBuffer (binary-safe BodyInit utk Response). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Text-to-speech — OpenAI-compatible /v1/audio/speech.
 *
 * Request:  { model, input, voice, response_format?, speed?, sample_rate? }
 * Response: binary audio (audio/mpeg by default) — NOT JSON.
 *
 * Dua mode (dari route target `mapping`), sama dengan adapter image:
 *
 *  verbatim (default) — body diteruskan apa adanya dengan model id upstream
 *  di-inject; response binary upstream diteruskan verbatim.
 *
 *  auto — body OpenAI-kanonik diterjemahkan ke dialek native target via
 *  mapSpeechInput() (lihat speech-mapper.ts): Qwen/DashScope
 *  (input.text/voice/format/sample_rate), OpenAI passthrough. Response JSON
 *  DashScope ({output:{audio:{data|url}}}) dinormalkan di sini menjadi binary
 *  audio + Content-Type yang benar, sehingga handler gateway tetap meneruskan
 *  binary apa adanya — klien tidak melihat perbedaan dialek upstream.
 */
export async function speech(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'speech', model);

  if (call.mapping !== 'auto') {
    return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
  }

  // ── mode auto: translate body OpenAI-kanonik → dialek native target ──
  const mapped = mapSpeechInput(body, provider, model);
  const res = await sendUpstream({ url, provider, body: JSON.stringify(mapped.body), signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });

  // Response sudah binary (provider OpenAI-compat) → teruskan verbatim.
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return res;

  // Response JSON → decode envelope audio DashScope jadi binary.
  const buf = Buffer.from(await res.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    // Bukan JSON valid — teruskan apa adanya (perilaku lama).
    return new Response(toArrayBuffer(buf), { status: res.status, headers: { 'Content-Type': ct } });
  }

  // Error top-level DashScope ({code, message}) bisa datang dengan HTTP 200.
  // Lempar sebagai GatewayCallError supaya engine bisa failover + error OpenAI
  // yang jelas sampai ke klien (bukan JSON error mentah berstatus 200).
  const errObj = json as { code?: unknown; message?: unknown; error?: { message?: string } };
  if (errObj?.error?.message || (typeof errObj?.code === 'string' && errObj.code && !/^(0|ok|success)$/i.test(errObj.code))) {
    const detail = errObj.error?.message ?? String(errObj.message ?? errObj.code);
    throw new GatewayCallError('server_error', `${provider.id} TTS failed: ${detail}`.slice(0, 400), res.status, {
      upstreamUrl: url, upstreamStatus: res.status, upstreamBody: buf.toString('utf8').slice(0, 1000),
    });
  }

  const audio = decodeQwenSpeechAudio(json);
  if (audio && audio.length > 0) {
    return new Response(toArrayBuffer(audio), { status: 200, headers: { 'Content-Type': speechContentType(mapped.intent.format), 'Content-Length': String(audio.length) } });
  }

  const audioUrl = qwenSpeechAudioUrl(json);
  if (audioUrl) {
    // Audio disimpan sementara di URL (OSS) — download lalu teruskan binary.
    let dl: Response;
    try {
      dl = await fetch(audioUrl, { signal, ...(call.dispatcher ? { dispatcher: call.dispatcher } : {}) });
    } catch (err) {
      throw new GatewayCallError('network', `Failed to download TTS audio: ${(err as Error).message}`);
    }
    if (!dl.ok) {
      throw new GatewayCallError('network', `Failed to download TTS audio (${dl.status}): ${audioUrl.slice(0, 120)}`);
    }
    const audio2 = Buffer.from(await dl.arrayBuffer());
    const dlCt = dl.headers.get('content-type')?.split(';')[0] ?? '';
    return new Response(toArrayBuffer(audio2), {
      status: 200,
      headers: { 'Content-Type': dlCt.startsWith('audio/') ? dlCt : speechContentType(mapped.intent.format), 'Content-Length': String(audio2.length) },
    });
  }

  // JSON tanpa audio → error upstream yang jelas (bukan JSON mentah ke klien).
  throw new GatewayCallError('server_error', `${provider.id} returned a JSON response without audio data.`, res.status, {
    upstreamUrl: url, upstreamStatus: res.status, upstreamBody: buf.toString('utf8').slice(0, 1000),
  });
}