/**
 * Netlify Edge Functions edge relay provider implementation.
 *
 * Deploy sebuah transparent-relay edge function ke Netlify (auto via API).
 * Edge function forward request ke provider mana pun (header x-relay-target),
 * shg 1 function serve semua provider & modality. Token Netlify disimpan
 * encrypted di DB (decrypt transient di buildRelayConfig, never logged).
 *
 * Netlify API (https://docs.netlify.com/api/get-started/):
 *   verify: GET    /api/v1/user                                 (Bearer token)
 *   site:   POST   /api/v1/sites | GET /api/v1/sites/{name}
 *   deploy: POST   /api/v1/sites/{site_id}/deploys  (zip upload) → upload zip
 *   remove: DELETE /api/v1/sites/{site_id}
 *
 * Netlify edge functions HARUS di-deploy via zip berisi struktur:
 *   netlify/edge-functions/relay.ts   (handler code)
 *   netlify.toml                       (declaration: route + edge function binding)
 * File-digest method (per-file upload) TIDAK support edge functions, hanya zip.
 *
 * ZIP: dibangun manual (store mode, tanpa kompresi — file kecil) supaya tidak
 * perlu dependency tambahan (jszip/adm-zip). Format ZIP sederhana: local file
 * header + central directory record + end of central directory.
 */
import type {
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
} from './types.js';

const NETLIFY_API = 'https://api.netlify.com/api/v1';

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Netlify Edge Function script — transparent forward via x-relay-target.
 * Netlify runtime signature: `export default async (request, context) => Response`.
 */
const EDGE_FUNCTION = `// SiberGate Edge Relay (Netlify Edge Function) — transparent forward.
// 1 function serve semua provider & modality. Deploy otomatis oleh SiberGate.
// @ts-nocheck
export default async function (request: Request, context: Context): Promise<Response> {
  const u = new URL(request.url);
  // Health check endpoint (dipakai SiberGate utk test connectivity).
  if (u.pathname === '/__health') {
    return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  const target = request.headers.get('x-relay-target');
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing x-relay-target header' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  // Bangun URL tujuan: target origin + path + query asli.
  const targetUrl = target.replace(/\\/+$/, '') + u.pathname + u.search;
  // Forward request apa adanya. Hapus header relay/host.
  const headers = new Headers(request.headers);
  headers.delete('x-relay-target');
  headers.delete('host');
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // @ts-ignore — duplex required utk streaming body di Edge runtime.
    init.duplex = 'half';
  }
  try {
    const res = await fetch(targetUrl, init);
    // Return response verbatim (streaming SSE tetap jalan).
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + ((e as Error)?.message || e) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
`;

/**
 * netlify.toml — bind edge function ke catch-all route. Tanpa ini, edge function
 * tidak ter-trigger. [[edge_functions]] declare path + function.
 */
const NETLIFY_TOML = `# SiberGate Edge Relay — Netlify config.
# Bind relay edge function ke catch-all route.
[[edge_functions]]
function = "relay"
path = "/*"
`;

interface NetlifyUser {
  id?: string;
  full_name?: string;
  email?: string;
}

interface NetlifySite {
  id?: string;
  name?: string;
  ssl_url?: string;
  subdomain?: string;
  url?: string;
}

interface NetlifyDeploy {
  id?: string;
  ssl_url?: string;
  url?: string;
}

interface NetlifyApiError {
  code?: number | string;
  message?: string;
}

/* ──────────── Minimal ZIP builder (store mode, no compression) ──────────── */
/**
 * Bangun ZIP buffer berisi file-file (path → content utf8). Store mode (method
 * 0, tanpa kompresi) — cukup utk file kecil. Implementasi spesifikasi ZIP:
 * tiap file = local file header + data, lalu central directory + EOCD.
 *
 * No dependency (jszip/adm-zip) — format ZIP sederhana utk store mode.
 * CRC32 dihitung manual (table-based). Timestamp DOS dikonversi dari Date.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Konversi Date → DOS time/date (16-bit each, packed utk ZIP header). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = ((((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f));
  return { time, date };
}

/** Tulis uint32/uint16 little-endian ke Uint8Array pada offset. */
function writeU16(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
}
function writeU32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

/** Bangun ZIP dari daftar file. Return Buffer. */
function buildZip(files: Array<{ path: string; content: string }>): Buffer {
  const { time, date } = dosDateTime(new Date());
  const encoded = files.map((f) => ({
    path: Buffer.from(f.path, 'utf8'),
    data: Buffer.from(f.content, 'utf8'),
  }));

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const f of encoded) {
    const crc = crc32(f.data);
    const nameLen = f.path.length;
    const dataLen = f.data.length;
    // Local file header (30 bytes + name + data).
    const local = Buffer.alloc(30 + nameLen + dataLen);
    writeU32(local, 0, 0x04034b50); // signature
    writeU16(local, 4, 20); // version needed
    writeU16(local, 6, 0); // flags
    writeU16(local, 8, 0); // method = store
    writeU16(local, 10, time);
    writeU16(local, 12, date);
    writeU32(local, 14, crc);
    writeU32(local, 18, dataLen); // compressed size = dataLen (store)
    writeU32(local, 22, dataLen); // uncompressed size
    writeU16(local, 26, nameLen);
    writeU16(local, 28, 0); // extra field length
    f.path.copy(local, 30);
    f.data.copy(local, 30 + nameLen);
    localParts.push(local);

    // Central directory record (46 bytes + name).
    const central = Buffer.alloc(46 + nameLen);
    writeU32(central, 0, 0x02014b50); // signature
    writeU16(central, 4, 20); // version made by
    writeU16(central, 6, 20); // version needed
    writeU16(central, 8, 0); // flags
    writeU16(central, 10, 0); // method
    writeU16(central, 12, time);
    writeU16(central, 14, date);
    writeU32(central, 16, crc);
    writeU32(central, 20, dataLen);
    writeU32(central, 24, dataLen);
    writeU16(central, 28, nameLen);
    writeU16(central, 30, 0); // extra field length
    writeU16(central, 32, 0); // comment length
    writeU16(central, 34, 0); // disk number
    writeU16(central, 36, 0); // internal attrs
    writeU32(central, 38, 0); // external attrs
    writeU32(central, 42, offset); // local header offset
    f.path.copy(central, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  // End of central directory record (22 bytes).
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, 0x06054b50); // signature
  writeU16(eocd, 4, 0); // disk number
  writeU16(eocd, 6, 0); // disk w/ central dir
  writeU16(eocd, 8, files.length);
  writeU16(eocd, 10, files.length);
  writeU32(eocd, 12, centralBuf.length);
  writeU32(eocd, 16, offset); // central dir offset
  writeU16(eocd, 20, 0); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

export const netlifyProvider: EdgeRelayProvider = {
  id: 'netlify-edge',
  displayName: 'Netlify Edge Functions',
  description:
    'Deploy edge function ke Netlify. Global edge network (Deno-based), gratis utk starter tier. Perlu zip deploy dgn struktur netlify/edge-functions/.',
  docsUrl: 'https://docs.netlify.com/edge-functions/overview/',
  status: 'active',
  configFields: [
    { key: 'apiToken', label: 'Netlify Personal Access Token', type: 'password', placeholder: 'nfp_xxx...', required: true,
      helper: 'Buat di User settings → Applications → Personal access tokens (https://app.netlify.com/user/applications).' },
    { key: 'siteName', label: 'Site Name', type: 'text', placeholder: 'sibergate-relay', required: false,
      helper: 'Nama site Netlify. URL = {site}.netlify.app. Default: sibergate-relay.' },
  ],

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const token = config.apiToken;
    if (typeof token !== 'string' || token.trim().length < 10) {
      errors.push('Netlify access token wajib diisi (min 10 karakter).');
    }
    return errors;
  },

  async verifyCredentials(config: Record<string, unknown>): Promise<VerifyResult> {
    const token = String(config.apiToken ?? '').trim();
    if (!token) return { ok: false, error: 'Access token kosong.' };
    try {
      const res = await fetch(`${NETLIFY_API}/user`, { headers: authHeaders(token) });
      const j = (await res.json()) as NetlifyUser & NetlifyApiError;
      if (!res.ok) {
        const msg = j.message ?? `HTTP ${res.status}`;
        return { ok: false, error: `Token invalid: ${msg}` };
      }
      const name = j.full_name ?? j.email ?? 'unknown';
      config.accountId = j.id;
      config.accountName = name;
      return { ok: true, accountInfo: { accountId: j.id ?? '', name } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async deploy(config: Record<string, unknown>): Promise<DeployResult> {
    const token = String(config.apiToken ?? '').trim();
    const siteName = String(config.siteName || 'sibergate-relay').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!token) return { ok: false, error: 'Access token kosong.' };
    if (!siteName) return { ok: false, error: 'Site name kosong.' };

    let siteId: string;
    let sslUrl: string;
    try {
      // 1. Cari site existing by name (subdomain pattern). Bila ada, reuse.
      const findRes = await fetch(`${NETLIFY_API}/sites?filter=all&name=${encodeURIComponent(siteName)}`, {
        headers: authHeaders(token),
      });
      const sites = (await findRes.json().catch(() => [])) as NetlifySite[];
      const existing = Array.isArray(sites) ? sites.find((s) => s.name === siteName) : undefined;

      if (existing?.id) {
        siteId = existing.id;
        sslUrl = existing.ssl_url ?? existing.url ?? `https://${siteName}.netlify.app`;
      } else {
        // 2. Create site baru (name = subdomain).
        const createRes = await fetch(`${NETLIFY_API}/sites`, {
          method: 'POST',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: siteName }),
        });
        const created = (await createRes.json()) as NetlifySite & NetlifyApiError;
        if (!createRes.ok || !created.id) {
          const msg = created.message ?? `HTTP ${createRes.status}`;
          return { ok: false, error: `Buat site gagal: ${msg}` };
        }
        siteId = created.id;
        sslUrl = created.ssl_url ?? created.url ?? `https://${siteName}.netlify.app`;
      }

      // 3. Build zip: netlify/edge-functions/relay.ts + netlify.toml.
      const zip = buildZip([
        { path: 'netlify/edge-functions/relay.ts', content: EDGE_FUNCTION },
        { path: 'netlify.toml', content: NETLIFY_TOML },
      ]);

      // 4. Upload zip sbg deploy body (Content-Type application/zip). Wrap ke
      // Blob supaya type-compatible dgn fetch BodyInit (Buffer tidak terima).
      const deployRes = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
        method: 'POST',
        headers: {
          ...authHeaders(token),
          'Content-Type': 'application/zip',
          'Content-Length': String(zip.length),
        },
        body: new Blob([new Uint8Array(zip)]),
      });
      const dep = (await deployRes.json()) as NetlifyDeploy & NetlifyApiError;
      if (!deployRes.ok || !dep.id) {
        const msg = dep.message ?? `HTTP ${deployRes.status}`;
        return { ok: false, error: `Deploy gagal: ${msg}` };
      }
      // URL = {site}.netlify.app (produksi stabil).
      const relayUrl = `https://${siteName}.netlify.app`;
      config.relayUrl = relayUrl;
      config.siteId = siteId;
      config.siteName = siteName;
      return { ok: true, relayUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(config: Record<string, unknown>): Promise<RemoveResult> {
    const token = String(config.apiToken ?? '').trim();
    const siteId = String(config.siteId ?? '').trim();
    if (!token) return { ok: false, error: 'Access token kosong.' };
    if (!siteId) return { ok: false, error: 'Site ID kosong (deploy dulu).' };
    try {
      const res = await fetch(`${NETLIFY_API}/sites/${siteId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (res.status === 404) return { ok: true };
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as NetlifyApiError;
        return { ok: false, error: j.message ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async testConnectivity(relayUrl: string): Promise<ConnectivityResult> {
    const start = Date.now();
    try {
      const url = `${relayUrl.replace(/\/+$/, '')}/__health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
      return { ok: true, latencyMs };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e.name === 'AbortError' ? 'timeout (8s)' : e.message,
      };
    }
  },

  buildRelayConfig(decryptedConfig: Record<string, unknown>, providerOrigin: string): EdgeRelayRuntime {
    const relayUrl = String(decryptedConfig.relayUrl ?? '').trim();
    return {
      url: relayUrl.replace(/\/+$/, ''),
      injectHeaders: { 'x-relay-target': providerOrigin.replace(/\/+$/, '') },
    };
  },
};
