/**
 * Deno Deploy edge relay provider implementation (v2 API).
 *
 * Deploy sebuah transparent-relay edge script ke Deno Deploy (auto via API).
 * Script forward request ke provider mana pun (header x-relay-target), shg
 * 1 script serve semua provider & modality. Token Deno disimpan encrypted di DB
 * (decrypt transient di buildRelayConfig, never logged).
 *
 * Deno Deploy v2 API (https://api.deno.com/v2/docs):
 *   orgs:    GET    /v2/organizations                  (Bearer token → list orgs)
 *   app:     POST   /v2/apps                           (create app by slug)
 *   deploy:  POST   /v2/apps/{slug}/deploy             (assets + config inline)
 *   app:     DELETE /v2/apps/{slug}                    (remove app + deploys)
 *
 * v2 model: Organization → App → Revision. "App" = project (slug = URL key),
 * "Revision" = deployment. URL = https://{slug}.deno.dev.
 *
 * ⚠️ Token wajib ORGANIZATION access token (prefix `ddo_`). Personal token
 * (`ddp_`) DITOLAK v2 API (redirect ke console → "route not found"). Token dibuat
 * di dashboard Settings → Access Tokens.
 */
import type {
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
} from './types.js';

const DENO_API = 'https://api.deno.com';

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Relay script — transparent forward via x-relay-target header.
 * Deno Deploy runtime: `export default { async fetch(request) }` (ES module).
 * Identik logic-nya dgn CF Worker (kedua runtime pakai fetch API standar).
 */
const RELAY_SCRIPT = `// SiberGate Edge Relay (Deno Deploy) — transparent forward.
// 1 script serve semua provider & modality. Deploy otomatis oleh SiberGate.
// @ts-nocheck
Deno.serve(async (request: Request): Promise<Response> => {
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
    // @ts-ignore — duplex required utk streaming body.
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
});
`;

interface DenoApiError {
  code?: string;
  message?: string;
  errors?: Array<{ detail?: string; message?: string }>;
}

interface DenoApp {
  id?: string;
  slug?: string;
  domains?: string[];
}

interface DenoDeployResponse {
  app?: { slug?: string; domains?: string[] };
  domains?: string[];
}

export const denoProvider: EdgeRelayProvider = {
  id: 'deno-deploy',
  displayName: 'Deno Deploy',
  description:
    'Deploy edge script ke Deno Deploy. ES module native, cold start cepat, global edge network. Gratis utk 1M request/hari. Syntax script hampir identik CF Worker.',
  docsUrl: 'https://docs.deno.com/deploy/',
  status: 'active',
  configFields: [
    { key: 'apiToken', label: 'Deno Deploy Access Token', type: 'password', placeholder: 'ddo_...', required: true,
      helper: 'WAJIB organization token (prefix ddo_). Buat di dashboard Settings → Access Tokens. Personal token (ddp_) DITOLAK API v2.' },
    { key: 'projectId', label: 'App Slug', type: 'text', placeholder: 'sibergate-relay', required: false,
      helper: 'Nama app (slug). URL = {slug}.deno.dev. Default: sibergate-relay.' },
  ],

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const token = config.apiToken;
    if (typeof token !== 'string' || token.trim().length < 10) {
      errors.push('Deno Deploy access token wajib diisi (min 10 karakter).');
    }
    return errors;
  },

  async verifyCredentials(config: Record<string, unknown>): Promise<VerifyResult> {
    const token = String(config.apiToken ?? '').trim();
    if (!token) return { ok: false, error: 'Access token kosong.' };
    // Cek prefix: v2 API hanya terima organization token (ddo_). Personal token
    // (ddp_) → redirect ke console → "route not found" (membingungkan user).
    if (token.startsWith('ddp_')) {
      return { ok: false, error: 'Token personal (ddp_) DITOLAK API v2. Buat organization token (ddo_) di dashboard.' };
    }
    try {
      // v2 API tidak punya endpoint /organizations atau /users/self yg stabil
      // (redirect ke console saat ditolak). Verify pakai GET /v2/apps (list apps)
      // yg ADA di spec resmi: 200 = token valid, 401 = invalid. Ambil 1 app
      // sbg bukti akses org.
      const res = await fetch(`${DENO_API}/v2/apps?limit=1`, { headers: authHeaders(token) });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as DenoApiError;
        const msg = j.message ?? j.code ?? `HTTP ${res.status}`;
        return { ok: false, error: `Token invalid: ${msg}` };
      }
      const apps = (await res.json()) as DenoApp[];
      const sample = Array.isArray(apps) ? apps[0] : undefined;
      config.accountId = sample?.id ?? '';
      config.accountName = sample?.slug ?? 'Deno Deploy';
      return { ok: true, accountInfo: { accountId: sample?.id ?? '', name: sample?.slug ?? 'Deno Deploy' } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async deploy(config: Record<string, unknown>): Promise<DeployResult> {
    const token = String(config.apiToken ?? '').trim();
    const slug = String(config.projectId || 'sibergate-relay').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!token) return { ok: false, error: 'Access token kosong.' };
    if (token.startsWith('ddp_')) {
      return { ok: false, error: 'Token personal (ddp_) DITOLAK API v2. Buat organization token (ddo_).' };
    }
    if (!slug) return { ok: false, error: 'App slug kosong.' };

    try {
      // 1. Create app (idempoten — 409 bila sudah ada, lanjut).
      const appRes = await fetch(`${DENO_API}/v2/apps`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ slug }),
      });
      // 409 = app sudah ada → OK, lanjut deploy. Error lain = gagal.
      if (!appRes.ok && appRes.status !== 409) {
        const j = (await appRes.json().catch(() => ({}))) as DenoApiError;
        const msg = j.message ?? j.code ?? `HTTP ${appRes.status}`;
        return { ok: false, error: `Buat app gagal: ${msg}` };
      }

      // 2. Deploy: POST /v2/apps/{slug}/deploy dgn assets inline + config runtime.
      // v2 model: assets = map filename → {kind:'file', encoding:'utf-8', content}.
      // config.runtime = {type:'dynamic', entrypoint}. production:true promote
      // revision ke production timeline shg {slug}.deno.dev langsung route.
      const deployRes = await fetch(`${DENO_API}/v2/apps/${slug}/deploy`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          production: true,
          assets: {
            'main.ts': {
              kind: 'file',
              encoding: 'utf-8',
              content: RELAY_SCRIPT,
            },
          },
          config: {
            runtime: {
              type: 'dynamic',
              entrypoint: 'main.ts',
            },
          },
        }),
      });
      if (!deployRes.ok) {
        const raw = await deployRes.text();
        let j: DenoApiError;
        try { j = JSON.parse(raw) as DenoApiError; } catch { j = { message: raw.slice(0, 200) }; }
        const msg = j.message ?? j.code ?? `HTTP ${deployRes.status}`;
        return { ok: false, error: `Deploy gagal: ${msg}` };
      }
      // Baca URL asli dari response deploy. URL pattern tergantung organization
      // (mis. {slug}.{org}.deno.net), jadi TIDAK boleh hardcode {slug}.deno.dev.
      // Deploy response = revision dgn timelines[].hostnames = URL routing asli.
      const depJson = (await deployRes.json().catch(() => ({}))) as {
        id?: string;
        timelines?: Array<{ name?: string; hostnames?: string[] }>;
      };
      const prodHosts = depJson.timelines
        ?.find((t) => /production/i.test(t.name ?? ''))
        ?.hostnames?.filter(Boolean);
      let relayUrl = Array.isArray(prodHosts) && prodHosts.length > 0 ? `https://${prodHosts[0]}` : '';
      // Fallback: bila deploy response belum punya hostname (build belum selesai
      // saat response), GET app utk ambil domain terdaftar.
      if (!relayUrl) {
        const appRes = await fetch(`${DENO_API}/v2/apps/${slug}`, { headers: authHeaders(token) });
        const appJson = (await appRes.json().catch(() => ({}))) as { domains?: string[] };
        const domains = appJson.domains ?? [];
        relayUrl = domains.length > 0 ? `https://${domains[0]}` : '';
      }
      if (!relayUrl) {
        return { ok: false, error: 'Deploy berhasil tapi URL tidak ditemukan di response. Cek dashboard Deno utk domain app.' };
      }
      config.relayUrl = relayUrl;
      config.projectId = slug;
      return { ok: true, relayUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(config: Record<string, unknown>): Promise<RemoveResult> {
    const token = String(config.apiToken ?? '').trim();
    const slug = String(config.projectId ?? 'sibergate-relay').trim().toLowerCase();
    if (!token || !slug) return { ok: false, error: 'Config tidak lengkap.' };
    try {
      const res = await fetch(`${DENO_API}/v2/apps/${slug}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (res.status === 404) return { ok: true };
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as DenoApiError;
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
