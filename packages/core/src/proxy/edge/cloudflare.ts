/**
 * Cloudflare Workers edge relay provider implementation.
 *
 * Deploy sebuah transparent-relay Worker ke akun CF user (auto via API).
 * Worker forward request ke provider mana pun (header x-relay-target), shg
 * 1 Worker serve semua provider & modality. Token CF disimpan encrypted di DB
 * (decrypt transient di buildRelayConfig, never logged).
 *
 * CF API:
 *   verify:    GET    /accounts                       (Bearer token)
 *   subdomain: GET    /accounts/{id}/workers/subdomain
 *   enable:    POST   /accounts/{id}/workers/scripts/{name}/subdomain
 *   deploy:    PUT    /accounts/{id}/workers/scripts/{name}  (multipart)
 *   delete:    DELETE /accounts/{id}/workers/scripts/{name}
 */
import type {
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
} from './types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Relay Worker script — transparent forward via x-relay-target header. */
const WORKER_SCRIPT = `// SiberGate Edge Relay (Cloudflare Worker) — transparent forward.
// 1 Worker serve semua provider & modality. Deploy otomatis oleh SiberGate.
export default {
  async fetch(request) {
    // Health check endpoint (dipakai SiberGate utk test connectivity).
    const u = new URL(request.url);
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
    // Forward request apa adanya (headers, body, method). Hapus header relay/host.
    const headers = new Headers(request.headers);
    headers.delete('x-relay-target');
    headers.delete('host');
    const init = {
      method: request.method,
      headers,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }
    try {
      const res = await fetch(targetUrl, init);
      // Return response verbatim (streaming SSE tetap jalan).
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + (e?.message || e) }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  },
};
`;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result?: T;
}

interface CfAccount {
  id: string;
  name: string;
}

interface CfSubdomain {
  subdomain: string;
}

/** Bangun multipart body utk PUT deploy Worker (Node 18+ FormData global). */
function buildDeployForm(): FormData {
  const fd = new FormData();
  // Metadata: main module name.
  fd.append(
    'metadata',
    new Blob(
      [JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-09-23' })],
      { type: 'application/json' },
    ),
  );
  // Script utama.
  fd.append('worker.js', new Blob([WORKER_SCRIPT], { type: 'application/javascript+module' }), 'worker.js');
  return fd;
}

export const cloudflareProvider: EdgeRelayProvider = {
  id: 'cloudflare-workers',
  displayName: 'Cloudflare Workers',
  requiredConfigFields: ['apiToken'],

  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const token = config.apiToken;
    if (typeof token !== 'string' || token.trim().length < 10) {
      errors.push('Cloudflare API token wajib diisi (min 10 karakter).');
    }
    return errors;
  },

  async verifyCredentials(config: Record<string, unknown>): Promise<VerifyResult> {
    const token = String(config.apiToken ?? '').trim();
    if (!token) return { ok: false, error: 'API token kosong.' };
    try {
      const res = await fetch(`${CF_API}/accounts`, { headers: authHeaders(token) });
      const j = (await res.json()) as CfResponse<CfAccount[]>;
      if (!res.ok || !j.success) {
        const msg = j.errors?.[0]?.message ?? `HTTP ${res.status}`;
        return { ok: false, error: `Token invalid: ${msg}` };
      }
      const accounts = j.result ?? [];
      if (accounts.length === 0) return { ok: false, error: 'Token valid tapi tidak ada account.' };
      // Simpan account id pertama ke config (dipakai deploy).
      config.accountId = accounts[0]!.id;
      config.accountName = accounts[0]!.name;
      return { ok: true, accountInfo: { accountId: accounts[0]!.id, name: accounts[0]!.name } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async deploy(config: Record<string, unknown>): Promise<DeployResult> {
    const token = String(config.apiToken ?? '').trim();
    const accountId = String(config.accountId ?? '').trim();
    const scriptName = String(config.scriptName ?? 'sibergate-relay').trim();
    if (!token) return { ok: false, error: 'API token kosong.' };
    if (!accountId) return { ok: false, error: 'Account ID kosong (jalankan verify dulu).' };

    try {
      // 1. PUT script (multipart).
      const fd = buildDeployForm();
      const putRes = await fetch(
        `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        },
      );
      const putJson = (await putRes.json().catch(() => ({ success: false, errors: [{ code: putRes.status, message: putRes.statusText }] }))) as CfResponse<unknown>;
      if (!putRes.ok || !putJson.success) {
        const cfErr = putJson.errors?.[0];
        // Pesan utk permission error (10000 = Authentication error, 10026 = could not authenticate).
        const hint = cfErr && (cfErr.code === 10000 || cfErr.code === 10026 || /auth/i.test(cfErr.message))
          ? ' Token CF butuh permission "Workers Scripts: Edit" + "Account: Read". Buat token baru di dash.cloudflare.com → My Profile → API Tokens.'
          : '';
        return { ok: false, error: `Deploy gagal (PUT script ${putRes.status}): ${cfErr?.message ?? putRes.statusText}${hint}` };
      }

      // 2. Enable workers.dev subdomain utk script ini (supaya ada URL publik).
      const enableRes = await fetch(
        `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ enabled: true }),
        },
      );
      // Ignore enable error (mungkin sudah enabled); tetap lanjut cari URL.

      // 3. Ambil account workers.dev subdomain utk bangun URL.
      const subRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
        headers: authHeaders(token),
      });
      const subJson = (await subRes.json()) as CfResponse<CfSubdomain>;
      const subdomain = subJson.result?.subdomain;
      if (!subdomain) {
        return { ok: false, error: 'Worker deployed tapi workers.dev subdomain tidak ditemukan. Aktifkan manual di dashboard CF.' };
      }
      const relayUrl = `https://${scriptName}.${subdomain}.workers.dev`;
      config.relayUrl = relayUrl;
      config.scriptName = scriptName;
      return { ok: true, relayUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async remove(config: Record<string, unknown>): Promise<RemoveResult> {
    const token = String(config.apiToken ?? '').trim();
    const accountId = String(config.accountId ?? '').trim();
    const scriptName = String(config.scriptName ?? 'sibergate-relay').trim();
    if (!token || !accountId) return { ok: false, error: 'Config tidak lengkap.' };
    try {
      const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      const j = (await res.json()) as CfResponse<unknown>;
      if (!res.ok || !j.success) {
        return { ok: false, error: j.errors?.[0]?.message ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async testConnectivity(relayUrl: string): Promise<ConnectivityResult> {
    const start = Date.now();
    try {
      // Hit endpoint /__health yg Worker sediakan.
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
    // x-relay-target = origin provider (mis. https://api.openai.com). Worker baca
    // header ini, gabung dgn path request, forward ke provider.
    return {
      url: relayUrl.replace(/\/+$/, ''),
      injectHeaders: { 'x-relay-target': providerOrigin.replace(/\/+$/, '') },
    };
  },
};
