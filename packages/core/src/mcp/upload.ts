import { GatewayCallError } from '../provider.js';
import { pushConsoleLog } from '../console-log.js';
import { mcpToolsCall, type McpCallOptions } from './client.js';

/**
 * Auto-upload aset (gambar referensi) ke server MCP via tool `file_upload`
 * (protokol Kling): tools/call file_upload → {ticket, uploadUrl} → POST
 * multipart (ticket + file bytes) → {data:{url}} URL hosted.
 *
 * Kenapa perlu: input model Kling (subject_image_0, image_1, first_image,
 * dst.) MENOLAK data-URI/base64 — harus URL absolut hasil file_upload.
 * Gateway menerjemahkan transparan: klien boleh kirim base64/data-URI di
 * field `image`; bila ref sudah http(s) URL, diteruskan apa adanya (model
 * gemini/gpt-image menerima URL eksternal langsung).
 */

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Parse ref (data-URI / base64 mentah) → bytes + mime. Null bila http URL. */
export function parseInlineAsset(ref: string): { bytes: Buffer; mime: string } | null {
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(ref);
  if (dataUri) {
    return { bytes: Buffer.from(dataUri[2]!, 'base64'), mime: dataUri[1]! };
  }
  // Base64 mentah (charset base64, cukup panjang, bukan skema URL).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(ref) && /^[A-Za-z0-9+/=\r\n]+$/.test(ref) && ref.length > 64) {
    return { bytes: Buffer.from(ref, 'base64'), mime: 'image/png' };
  }
  return null;
}

/** Ambil nilai pertama yg ada dari beberapa kemungkinan nama key (camel/snake). */
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** Upload satu aset inline → URL hosted di server MCP. */
export async function uploadMcpAsset(
  provider: { id: string },
  asset: { bytes: Buffer; mime: string },
  opts?: McpCallOptions,
): Promise<string> {
  const ext = MIME_EXT[asset.mime.split(';')[0]!] ?? 'png';
  const filename = `sibergate-${Date.now()}.${ext}`;
  // 1. Ticket via tools/call file_upload.
  const ticketRes = await mcpToolsCall(
    provider as never,
    'file_upload',
    { filename, contentType: asset.mime, size: asset.bytes.length },
    opts,
  );
  const text = ticketRes.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  let ticketJson: Record<string, unknown> | null = null;
  try {
    ticketJson = JSON.parse(text) as Record<string, unknown>;
  } catch {
    ticketJson = null;
  }
  const ticket = ticketJson ? pick(ticketJson, ['ticket']) : undefined;
  const uploadUrl = ticketJson ? pick(ticketJson, ['uploadUrl', 'upload_url']) : undefined;
  if (!ticket || !uploadUrl) {
    throw new GatewayCallError(
      'server_error',
      `file_upload tidak mengembalikan ticket/uploadUrl: ${text.slice(0, 200)}`,
    );
  }

  // 2. POST multipart (ticket + file) ke uploadUrl.
  const boundary = `sgmcp${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="ticket"\r\n\r\n${ticket}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${asset.mime}\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    asset.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
      signal: opts?.signal,
    });
  } catch (err) {
    throw new GatewayCallError('network', `Gagal upload file ke server MCP: ${(err as Error).message}`);
  }
  const upJson = (await res.json().catch(() => null)) as
    | { status?: number; result?: number; data?: { url?: unknown }; message?: unknown }
    | null;
  const hostedUrl =
    typeof upJson?.data?.url === 'string' && upJson.data.url
      ? upJson.data.url
      : undefined;
  if (!res.ok || !hostedUrl) {
    throw new GatewayCallError(
      'server_error',
      `Upload file gagal (HTTP ${res.status}): ${JSON.stringify(upJson).slice(0, 200)}`,
    );
  }
  pushConsoleLog('info', 'mcp', `file_upload ${provider.id}: ${filename} (${asset.bytes.length}B) → hosted`, {
    provider: provider.id, filename, bytes: asset.bytes.length,
  });
  return hostedUrl;
}

/**
 * Pastikan semua ref gambar berupa URL absolut http(s). Ref inline
 * (data-URI/base64) di-upload otomatis via file_upload; bila server tidak
 * punya tool itu, ref diteruskan apa adanya (error jelas dari server).
 * Ref http(s) diteruskan langsung (tanpa re-upload — hemat bandwidth).
 */
export async function ensureHostedAssetRefs(
  provider: { id: string },
  refs: string[],
  opts?: McpCallOptions,
): Promise<string[]> {
  if (!refs.length) return refs;
  const inline = refs.some((r) => parseInlineAsset(r) !== null);
  if (!inline) return refs; // semua sudah URL — tidak ada kerja upload
  return Promise.all(
    refs.map(async (ref, i) => {
      const asset = parseInlineAsset(ref);
      if (!asset) return ref;
      try {
        return await uploadMcpAsset(provider, asset, opts);
      } catch (err) {
        const e = err as Error;
        pushConsoleLog('warn', 'mcp', `auto-upload ref #${i + 1} gagal: ${e.message?.slice(0, 200)}`, {
          provider: provider.id,
        });
        // Gagal upload → teruskan ref asli; server memberi error spesifik.
        return ref;
      }
    }),
  );
}
