import { sendUpstream, upstreamUrl, GatewayCallError, type AdapterCall } from '../provider.js';
import { mapImageInput } from '../image-mapper.js';

/**
 * Image generation — OpenAI-compatible /v1/images/generations (JSON in, JSON/SSE out).
 *
 * Request:  { model, prompt, n?, size?, response_format?, quality?, style? }
 * Response: { created, data: [{ url } | { b64_json }] }
 *
 * Dua mode (dari route target `mapping`):
 *
 *  verbatim (default) — body diteruskan apa adanya dengan model id upstream
 *  di-inject. Kling AI quirk: Kling's image API expects the field `model_name`,
 *  not `model`. When the provider's baseUrl or image endpoint contains
 *  'klingai', we rename `model` → `model_name` (drop the old `model` field) so
 *  the OpenAI-compatible client can keep sending `model` while Kling gets what
 *  it wants. This keeps the rename scoped to image + Kling only.
 *
 *  auto — body OpenAI-kanonik diterjemahkan ke dialek native target via
 *  mapImageInput() (lihat image-mapper.ts): Kling (model_name/aspect_ratio),
 *  Qwen (input.messages/parameters), OpenAI passthrough. Bila target OpenAI
 *  dan client membawa gambar referensi, request di-redirect ke endpoint
 *  /v1/images/edits dan dikirim sebagai multipart/form-data — di dunia
 *  OpenAI "generasi dengan gambar referensi" hidup di sana (struktural).
 */

/** Ekstensi file dari mime type image (untuk filename part multipart). */
function extFor(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

/**
 * Ubah sumber gambar (URL http(s) | data-URL base64 | base64 mentah) jadi
 * Blob utk file part FormData. Gagal download → GatewayCallError 'network'
 * supaya engine bisa failover ke target berikutnya.
 */
async function imageSourceToBlob(src: string, signal?: AbortSignal): Promise<Blob> {
  // data:image/png;base64,....
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (dataUrl && dataUrl[1] && dataUrl[2]) {
    return new Blob([base64ToArrayBuffer(dataUrl[2])], { type: dataUrl[1] });
  }
  // Base64 mentah (tanpa skema) — heuristik: charset base64 & cukup panjang.
  if (!/^(https?:)?\/\//i.test(src) && /^[A-Za-z0-9+/=\r\n]+$/.test(src) && src.length > 64) {
    return new Blob([base64ToArrayBuffer(src)], { type: 'image/png' });
  }
  // URL publik → download.
  let res: Response;
  try {
    res = await fetch(src, { signal });
  } catch (err) {
    throw new GatewayCallError('network', `Failed to download reference image: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new GatewayCallError('network', `Failed to download reference image (${res.status}): ${src.slice(0, 120)}`);
  }
  const type = res.headers.get('content-type')?.split(';')[0] ?? 'image/png';
  return new Blob([await res.arrayBuffer()], { type: type.startsWith('image/') ? type : 'image/png' });
}

/** Decode base64 → ArrayBuffer (binary-safe; ArrayBuffer selalu valid BlobPart). */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ''));
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return buf;
}

/**
 * Build FormData utk OpenAI /v1/images/edits. Field file: 'image' (satu) atau
 * 'image[]' (banyak, konvensi SDK OpenAI utk multi-image gpt-image-1) + mask
 * opsional. Field string lain diteruskan dari hasil mapper.
 */
async function buildEditsFormData(
  mapped: { fields: Record<string, string>; images: string[]; mask?: string },
  signal?: AbortSignal,
): Promise<FormData> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(mapped.fields)) fd.append(k, v);
  const blobs = await Promise.all(mapped.images.map((src) => imageSourceToBlob(src, signal)));
  blobs.forEach((blob, i) => {
    const name = blobs.length > 1 ? 'image[]' : 'image';
    fd.append(name, blob, `image-${i}.${extFor(blob.type)}`);
  });
  if (mapped.mask) {
    const maskBlob = await imageSourceToBlob(mapped.mask, signal);
    fd.append('mask', maskBlob, `mask.${extFor(maskBlob.type)}`);
  }
  return fd;
}

export async function image(call: AdapterCall): Promise<Response> {
  const { provider, model, body, signal } = call;
  const url = upstreamUrl(provider, 'image', model);

  // ── mode auto: translate body OpenAI-kanonik → dialek native target ──
  if (call.mapping === 'auto') {
    const mapped = mapImageInput(body, provider, model);
    if (mapped.kind === 'edits') {
      // OpenAI + gambar referensi → redirect ke /v1/images/edits (multipart).
      const editsUrl = url.replace(/\/generations(?=\/?$)/, '/edits');
      if (editsUrl === url) {
        throw new GatewayCallError('unsupported', `Provider ${provider.id} image endpoint is not a /generations template; cannot redirect to /edits.`);
      }
      const fd = await buildEditsFormData(mapped, signal);
      // Body FormData: JANGAN set Content-Type manual — boundary di-set fetch.
      return sendUpstream({ url: editsUrl, provider, body: fd, signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
    }
    const upstreamBody = JSON.stringify(mapped.body);
    const headers: Record<string, string> = {};
    if (body.stream) headers.Accept = 'text/event-stream';
    return sendUpstream({ url, provider, body: upstreamBody, signal, contentType: 'application/json', passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
  }

  // ── mode verbatim (default, perilaku lama) ──
  // Deteksi provider Kling: baseUrl atau endpoint image mengandung 'klingai'.
  const isKling = /klingai/i.test(provider.baseUrl) || /klingai/i.test(provider.endpoints.image ?? '');
  if (isKling) {
    const { model: _drop, ...rest } = body;
    return sendUpstream({ url, provider, body: JSON.stringify({ ...rest, model_name: model }), signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
  }
  return sendUpstream({ url, provider, body: JSON.stringify({ ...body, model }), signal, passthroughHeaders: call.passthroughHeaders, dispatcher: call.dispatcher, relay: call.relay });
}
