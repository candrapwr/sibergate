import { sendUpstream, upstreamUrl, GatewayCallError, type AdapterCall } from '../provider.js';
import {
  mapSpeechInput,
  qwenSpeechAudioUrl,
  decodeQwenSpeechAudio,
  decodeGeminiSpeechAudio,
  geminiSpeechToFormat,
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
 *  (input.text/voice/format/sample_rate), Gemini generateContent
 *  (contents + generationConfig.speechConfig; response PCM → WAV),
 *  OpenAI passthrough. Response JSON upstream dinormalkan di sini menjadi
 *  binary audio + Content-Type yang benar, sehingga handler gateway tetap
 *  meneruskan binary apa adanya — klien tidak melihat perbedaan dialek.
 */
export async function speech(call: AdapterCall): Promise<Response> {
  let { provider } = call;
  const { model, body, signal } = call;
  // Mode auto + dialek Gemini: model ada di URL (:generateContent), bukan body.
  // Endpoint provider mungkin masih template OpenAI-compat — override di sini
  // supaya route auto-map tidak perlu mengubah konfigurasi provider.
  const auto = call.mapping === 'auto' ? mapSpeechInput(body, provider, model) : null;
  let url: string;
  if (auto?.dialect === 'gemini') {
    const base = provider.baseUrl.replace(/\/+$/, '');
    url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    // Native Google API menolak Authorization: Bearer utk API key (401) —
    // harus header x-goog-api-key. Provider gemini umumnya authScheme
    // 'bearer' (utk endpoint OpenAI-compat), jadi override khusus panggilan
    // ini saja; konfigurasi provider tidak diubah.
    provider = { ...provider, authScheme: 'none', headers: { ...provider.headers, 'x-goog-api-key': provider.apiKey } };
  } else {
    url = upstreamUrl(provider, 'speech', model);
  }

  if (!auto) {
    return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
  }

  // ── mode auto: translate body OpenAI-kanonik → dialek native target ──
  const mapped = auto;
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

  // Gemini: candidates[].content.parts[].inlineData (PCM base64) → WAV/PCM.
  if (mapped.dialect === 'gemini') {
    const g = decodeGeminiSpeechAudio(json);
    if (g && g.audio.length > 0) {
      const norm = geminiSpeechToFormat(g.audio, g.mimeType, mapped.intent.format);
      return new Response(toArrayBuffer(norm.audio), { status: 200, headers: { 'Content-Type': norm.contentType, 'Content-Length': String(norm.audio.length) } });
    }
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