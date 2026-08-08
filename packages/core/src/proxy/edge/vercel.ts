/**
 * Vercel Edge Functions edge relay provider implementation.
 *
 * Deploy sebuah transparent-relay Edge Function ke akun Vercel user (auto via
 * API). Edge function forward request ke provider mana pun (header
 * x-relay-target), shg 1 function serve semua provider & modality. Token Vercel
 * disimpan encrypted di DB (decrypt transient di buildRelayConfig, never logged).
 *
 * Vercel REST API (https://vercel.com/docs/rest-api):
 *   verify: GET  /v2/user                              (Bearer token)
 *   project: POST /v10/projects   | GET /v9/projects/{name}
 *   deploy:  POST /v13/deployments?teamId=...          (inline files, base64)
 *   remove:  DELETE /v9/projects/{name}?teamId=...
 *
 * Edge function: runtime 'edge' (global), handler signature `export default
 * function(req)`. Inline deploy lewat file `api/relay.ts` + `vercel.json` (routes
 * catch-all → /api/relay, runtime edge). Public URL = {project}.vercel.app.
 */
import type {
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
} from './types.js';

const VERCEL_API = 'https://api.vercel.com';

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Query-string utk Vercel API. Handle teamId (opsional) + param tambahan
 *  (mis. forceNew) dgn benar — selalu mulai dgn '?' bila ada param manapun,
 *  jadi tidak ada '&forceNew' tanpa '?'. */
function buildQuery(config: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  const t = String(config.teamId ?? '').trim();
  if (t) params.set('teamId', t);
  for (const [k, v] of Object.entries(extra)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Edge function script — transparent forward via x-relay-target header.
 * Vercel Edge runtime signature: `export default function(req: Request)`.
 */
const EDGE_FUNCTION = `// SiberGate Edge Relay (Vercel Edge Function) — transparent forward.
// 1 function serve semua provider & modality. Deploy otomatis oleh SiberGate.
export const config = { runtime: 'edge' };

export default async function (request: Request): Promise<Response> {
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
 * vercel.json — route catch-all ke /api/relay shg semua path diteruskan ke
 * edge function (termasuk /v1/chat/completions, /__health, dll). Tanpa ini,
 * hanya path persis /api/relay yg match.
 */
const VERCEL_JSON = JSON.stringify({
  routes: [{ src: '/(.*)', dest: '/api/relay' }],
});

interface VercelUser {
  user?: { uid: string; email?: string; name?: string; username?: string };
  team?: { id: string; name: string; slug: string } | null;
}

interface VercelDeployResponse {
  id?: string;
  url?: string; // deployment URL (xxx.vercel.app)
  readyState?: string;
  alias?: string[];
  errorCode?: string;
  errorMessage?: string | null;
}

interface VercelApiError {
  error?: { code?: string; message?: string };
}

/** Upload inline file helper: base64-encode + sha256 utk inlining di deploy. */
function inlineFile(path: string, content: string): { file: string; data: string; encoding: string } {
  return {
    file: path,
    data: Buffer.from(content, 'utf8').toString('base64'),
    encoding: 'base64',
  };
}

export const vercelProvider: EdgeRelayProvider = {
  id: 'vercel-edge',
  displayName: 'Vercel Edge Functions',
  description:
    'Deploy edge function ke Vercel. Global edge network, cold start cepat, gratis utk hobby tier (limit request/hari). Alternatif bagus ke Cloudflare.',
  docsUrl: 'https://vercel.com/docs/functions/edge-functions',
  status: 'active',
  configFields: [
    { key: 'apiToken', label: 'Vercel Access Token', type: 'password', placeholder: 'vercel_xxx...', required: true,
      helper: 'Buat di Account Settings → Tokens (https://vercel.com/account/tokens). Scope: Full Account.' },
    { key: 'teamId', label: 'Team ID / Slug', type: 'text', placeholder: 'team_xxx atau slug (opsional)', required: false,
      helper: 'Kosongkan utk akun personal. Isi bila deploy ke team tertentu.' },
    { key: 'projectName', label: 'Project Name', type: 'text', placeholder: 'sibergate-relay', required: false,
      helper: 'Nama project Vercel. Default: sibergate-relay. URL = {project}.vercel.app.' },
  ],

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const token = config.apiToken;
    if (typeof token !== 'string' || token.trim().length < 10) {
      errors.push('Vercel access token wajib diisi (min 10 karakter).');
    }
    return errors;
  },

  async verifyCredentials(config: Record<string, unknown>): Promise<VerifyResult> {
    const token = String(config.apiToken ?? '').trim();
    if (!token) return { ok: false, error: 'Access token kosong.' };
    try {
      // GET /v2/user verifikasi token + ambil identitas.
      const res = await fetch(`${VERCEL_API}/v2/user${buildQuery(config)}`, { headers: authHeaders(token) });
      const j = (await res.json()) as VercelUser & VercelApiError;
      if (!res.ok) {
        const msg = j.error?.message ?? `HTTP ${res.status}`;
        return { ok: false, error: `Token invalid: ${msg}` };
      }
      const u = j.user;
      const name = u?.name ?? u?.username ?? u?.email ?? 'unknown';
      config.accountId = u?.uid; // simpan utk referensi (deploy pakai projectName/teamId)
      config.accountName = name;
      return { ok: true, accountInfo: { accountId: u?.uid ?? '', name } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async deploy(config: Record<string, unknown>): Promise<DeployResult> {
    const token = String(config.apiToken ?? '').trim();
    const projectName = String(config.projectName || 'sibergate-relay').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!token) return { ok: false, error: 'Access token kosong.' };
    if (!projectName) return { ok: false, error: 'Project name kosong.' };

    try {
      // 1. Pastikan project ada (create-if-missing). Vercel auto-create project
      // saat deployment pertama dgn name tertentu, tapi eksplisit lebih aman.
      const projRes = await fetch(`${VERCEL_API}/v10/projects${buildQuery(config)}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: projectName }),
      });
      const projJson = (await projRes.json()) as { id?: string } & VercelApiError;
      // 409 = project sudah ada (OK, lanjut). Error lain = gagal.
      if (!projRes.ok && projRes.status !== 409) {
        const msg = projJson.error?.message ?? `HTTP ${projRes.status}`;
        return { ok: false, error: `Buat project gagal: ${msg}` };
      }

      // 2. Deploy: inline files (api/relay.ts + vercel.json), target production.
      // buildQuery gabungkan teamId + forceNew dgn benar (selalu mulai '?').
      const deployRes = await fetch(`${VERCEL_API}/v13/deployments${buildQuery(config, { forceNew: '1' })}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          name: projectName,
          target: 'production',
          files: [
            inlineFile('api/relay.ts', EDGE_FUNCTION),
            inlineFile('vercel.json', VERCEL_JSON),
          ],
          projectSettings: { framework: null },
        }),
      });
      const d = (await deployRes.json()) as VercelDeployResponse & VercelApiError;
      if (!deployRes.ok || d.error) {
        const msg = d.error?.message ?? `HTTP ${deployRes.status}`;
        return { ok: false, error: `Deploy gagal: ${msg}` };
      }
      // URL produksi: {project}.vercel.app (deployment.url adalah preview hash).
      // d.alias biasanya berisi production domain bila ready; tp kita pakai
      // pattern stabil {project}.vercel.app.
      const relayUrl = `https://${projectName}.vercel.app`;
      config.relayUrl = relayUrl;
      config.projectName = projectName;
      return { ok: true, relayUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(config: Record<string, unknown>): Promise<RemoveResult> {
    const token = String(config.apiToken ?? '').trim();
    const projectName = String(config.projectName || 'sibergate-relay').trim().toLowerCase();
    if (!token || !projectName) return { ok: false, error: 'Config tidak lengkap.' };
    try {
      const res = await fetch(`${VERCEL_API}/v9/projects/${projectName}${buildQuery(config)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      // 404 = sudah terhapus (anggap sukses).
      if (res.status === 404) return { ok: true };
      const j = (await res.json().catch(() => ({}))) as VercelApiError;
      if (!res.ok) return { ok: false, error: j.error?.message ?? `HTTP ${res.status}` };
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
