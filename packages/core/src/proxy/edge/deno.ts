/**
 * Deno Deploy edge relay provider implementation.
 *
 * Deploy sebuah transparent-relay edge script ke Deno Deploy (auto via API).
 * Script forward request ke provider mana pun (header x-relay-target), shg
 * 1 script serve semua provider & modality. Token Deno disimpan encrypted di DB
 * (decrypt transient di buildRelayConfig, never logged).
 *
 * Deno Deploy API:
 *   verify: GET    https://api.deno.com/v2/users/self        (Bearer token)
 *   deploy: POST   https://deploy.deno.com/v1/deployments    (multipart: project + entrypoint source)
 *   remove: DELETE https://api.deno.com/v2/projects/{name}   (Bearer token)
 *
 * Deno support ES module native — script hampir identik dgn Cloudflare Worker
 * (`export default { async fetch(request) }`). Public URL = {project}.deno.dev.
 *
 * Catatan: deploy.deno.com/v1 adalah "classic" API (single-file). Alternatif
 * api.deno.com/v2 butuh asset upload multi-file (lebih kompleks). Classic API
 * paling cocok utk relay single-file.
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
const DENO_DEPLOY = 'https://deploy.deno.com';

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Relay script — transparent forward via x-relay-target header.
 * Deno Deploy runtime: `export default { async fetch(request) }` (ES module).
 * Identik logic-nya dgn CF Worker (kedua runtime pakai fetch API standar).
 */
const RELAY_SCRIPT = `// SiberGate Edge Relay (Deno Deploy) — transparent forward.
// 1 script serve semua provider & modality. Deploy otomatis oleh SiberGate.
// @ts-nocheck
export default {
  async fetch(request: Request): Promise<Response> {
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
  },
};
`;

interface DenoUser {
  id?: string;
  name?: string;
  email?: string;
}

interface DenoDeployResponse {
  domain?: { id: string; domain: string }; // {project}.deno.dev
  url?: string;
  id?: string;
  error?: { code?: string; message?: string } | string;
}

interface DenoApiError {
  code?: string;
  message?: string;
  errors?: Array<{ detail?: string }>;
}

/** Bangun multipart body utk POST deploy.deno.com/v1/deployments. */
function buildDeployForm(project: string, source: string): FormData {
  const fd = new FormData();
  // URL gambar / project config: klasik API terima import_map URL (opsional) +
  // entrypoint source sbg file bernama sesuai (mis. relay.ts). Project name di
  // field "project".
  fd.append('project', project);
  // Entrypoint: source code sbg file. Nama bebas tapi harus match main_module.
  const blob = new Blob([source], { type: 'application/typescript' });
  fd.append('file', blob, 'relay.ts');
  return fd;
}

export const denoProvider: EdgeRelayProvider = {
  id: 'deno-deploy',
  displayName: 'Deno Deploy',
  description:
    'Deploy edge script ke Deno Deploy. ES module native, cold start cepat, global edge network. Gratis utk 1M request/hari. Syntax script hampir identik CF Worker.',
  docsUrl: 'https://docs.deno.com/deploy/',
  status: 'active',
  configFields: [
    { key: 'apiToken', label: 'Deno Deploy Access Token', type: 'password', placeholder: 'ddo_xxx...', required: true,
      helper: 'Buat di https://dash.deno.com/account#access-tokens. Scope: Full Access atau project write.' },
    { key: 'projectId', label: 'Project Name', type: 'text', placeholder: 'sibergate-relay', required: false,
      helper: 'Nama project Deno Deploy. URL = {project}.deno.dev. Default: sibergate-relay.' },
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
    try {
      const res = await fetch(`${DENO_API}/v2/users/self`, { headers: authHeaders(token) });
      const j = (await res.json()) as DenoUser & DenoApiError;
      if (!res.ok) {
        const msg = j.message ?? j.code ?? `HTTP ${res.status}`;
        return { ok: false, error: `Token invalid: ${msg}` };
      }
      const name = j.name ?? j.email ?? 'unknown';
      config.accountId = j.id;
      config.accountName = name;
      return { ok: true, accountInfo: { accountId: j.id ?? '', name } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async deploy(config: Record<string, unknown>): Promise<DeployResult> {
    const token = String(config.apiToken ?? '').trim();
    const projectId = String(config.projectId || 'sibergate-relay').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!token) return { ok: false, error: 'Access token kosong.' };
    if (!projectId) return { ok: false, error: 'Project name kosong.' };

    try {
      // Klasik single-file deploy API. Multipart: project + source file.
      // Endpoint menerima Authorization header (bukan cookie).
      const fd = buildDeployForm(projectId, RELAY_SCRIPT);
      const res = await fetch(`${DENO_DEPLOY}/v1/deployments`, {
        method: 'POST',
        headers: { ...authHeaders(token) },
        body: fd,
      });
      const raw = await res.text();
      let j: DenoDeployResponse & DenoApiError;
      try {
        j = JSON.parse(raw) as DenoDeployResponse & DenoApiError;
      } catch {
        j = { message: raw.slice(0, 200) };
      }
      if (!res.ok || j.error) {
        const errDetail = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? `HTTP ${res.status}`;
        return { ok: false, error: `Deploy gagal: ${errDetail}` };
      }
      // URL = {project}.deno.dev (stabil). Response j.domain.domain juga bisa.
      const relayUrl = `https://${projectId}.deno.dev`;
      config.relayUrl = relayUrl;
      config.projectId = projectId;
      return { ok: true, relayUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(config: Record<string, unknown>): Promise<RemoveResult> {
    const token = String(config.apiToken ?? '').trim();
    const projectId = String(config.projectId || 'sibergate-relay').trim().toLowerCase();
    if (!token || !projectId) return { ok: false, error: 'Config tidak lengkap.' };
    try {
      const res = await fetch(`${DENO_API}/v2/projects/${projectId}`, {
        method: 'DELETE',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
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
