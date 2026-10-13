import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db.js';
import { decryptJSON, encryptJSON, type EncryptedBlob } from '../crypto.js';

/**
 * OAuth 2.1 client untuk provider MCP (MCP Authorization spec, 2025-06-18).
 *
 * Banyak server MCP publik — termasuk Kling (https://kling.ai/mcp) — memakai
 * OAuth login browser alih-alih API key: operator klik "Connect" di UI admin,
 * login di browser, dan gateway menerima authorization code di redirect_uri.
 *
 * Alur:
 *   1. discoverMcpOAuth()   — RFC 9728 /.well-known/oauth-protected-resource
 *                             → RFC 8414 /.well-known/oauth-authorization-server
 *   2. dynamic registration — RFC 7591 (server tanpa registration → error jelas)
 *   3. startMcpOAuth()      — URL otorisasi + PKCE S256 + state (pending flow
 *                             dipegang in-memory, TTL 10 menit)
 *   4. handleMcpOAuthCallback() — tukar code→token (form-encoded), simpan
 *                             terenkripsi di tabel mcp_oauth
 *   5. getValidMcpAccessToken()  — akses runtime; refresh otomatis saat expired
 *
 * Redirect URI harus bisa dijangkau browser OPERATOR (bukan oleh server Kling):
 * default http://localhost:8787 (gateway lokal), override SIBERGATE_PUBLIC_URL.
 */

const PKCE_VERIFIER_BYTES = 32;
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Endpoint OAuth hasil discovery. */
export interface McpOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Resource indicator (RFC 8707) bila server mendeklarasikannya. */
  resource?: string;
  /** Scope yg didukung server (space-delimited) — diminta eksplisit saat authorize. */
  scope?: string;
}

interface StoredTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

interface PendingFlow {
  providerId: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

/** Pending authorization flows (state → flow). In-memory; gateway = 1 proses. */
const pendingFlows = new Map<string, PendingFlow>();

/** Base URL publik gateway (untuk redirect_uri), tanpa trailing slash. */
export function gatewayPublicBaseUrl(): string {
  const fromEnv = process.env.SIBERGATE_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  // Konsisten dengan gateway (SIBERGATE_PORT, default 8787) supaya redirect_uri
  // callback bisa dijangkau browser operator tanpa konfigurasi tambahan.
  const port = process.env.SIBERGATE_PORT || '8787';
  return `http://localhost:${port}`;
}

/** redirect_uri standar utk flow OAuth MCP. */
export function mcpOAuthRedirectUri(): string {
  return `${gatewayPublicBaseUrl()}/admin/mcp/oauth/callback`;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* body bukan JSON */
  }
  return { status: res.status, json };
}

/**
 * Discovery metadata OAuth dari sebuah MCP endpoint (baseUrl provider).
 *
 * Urutan percobaan (sesuai spec MCP + fallback umum):
 *   1. {origin}/.well-known/oauth-protected-resource (RFC 9728) → daftar AS.
 *   2. Untuk tiap AS: metadata RFC 8414. ISSUER BOLEH PUNYA PATH (mis. Kling:
 *      https://kling.ai/auth) — well-known-nya dicoba di TIGA bentuk:
 *        a. {origin}/.well-known/oauth-authorization-server{path}  (RFC 8414 insert)
 *        b. {issuer}/.well-known/oauth-authorization-server        (append — umum)
 *        c. {origin}/.well-known/oauth-authorization-server        (root)
 *   3. Fallback bila (1) 404: coba AS = origin MCP endpoint langsung.
 *   4. Fallback terakhir: endpoint default /authorize & /token di origin.
 */
export async function discoverMcpOAuth(mcpEndpointUrl: string): Promise<McpOAuthEndpoints> {
  const mcpUrl = new URL(mcpEndpointUrl);
  const candidates: string[] = [];
  try {
    const { status, json } = await fetchJson(
      new URL('/.well-known/oauth-protected-resource', mcpUrl.origin).href,
    );
    if (status === 200 && json) {
      const servers: string[] = Array.isArray(json.authorization_servers)
        ? json.authorization_servers.filter((s: unknown): s is string => typeof s === 'string')
        : [];
      // scopes_supported bisa dideklarasikan di PR metadata maupun AS metadata.
      const scope = normalizeScopes(json.scopes_supported);
      if (json.resource && typeof json.resource === 'string') {
        // Resource indicator dikembalikan di sini; sertakan pada request berikutnya.
        const found = await tryAuthorizationServer(servers, json.resource, scope);
        if (found) return found;
      }
      if (servers.length) {
        const found = await tryAuthorizationServer(servers, undefined, scope);
        if (found) return found;
      }
    }
  } catch {
    /* network error → lanjut fallback */
  }

  // Fallback: origin MCP endpoint sebagai AS.
  const fallback = await tryAuthorizationServer([mcpUrl.origin], undefined, undefined);
  if (fallback) return fallback;

  // Fallback terakhir: path default (banyak implementasi memakai ini).
  return {
    authorizationEndpoint: new URL('/authorize', mcpUrl.origin).href,
    tokenEndpoint: new URL('/token', mcpUrl.origin).href,
  };
}

/** Gabungkan daftar scope jadi satu string space-delimited (OAuth form). */
function normalizeScopes(scopes: unknown): string | undefined {
  if (!Array.isArray(scopes)) return undefined;
  const list = scopes.filter((s): s is string => typeof s === 'string' && !!s);
  return list.length ? list.join(' ') : undefined;
}

async function tryAuthorizationServer(
  issuers: string[],
  resource?: string,
  scope?: string,
): Promise<McpOAuthEndpoints | null> {
  for (const issuer of issuers) {
    if (!/^https?:\/\//.test(issuer)) continue;
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/+$/, '');
    // Tiga bentuk well-known utk issuer dgn path (Kling: /auth).
    const variants = [
      `${u.origin}/.well-known/oauth-authorization-server${path}`, // RFC 8414 insert
      `${u.origin}${path}/.well-known/oauth-authorization-server`, // append
      `${u.origin}/.well-known/oauth-authorization-server`,        // root
    ];
    for (const wellKnown of variants) {
      try {
        const { status, json } = await fetchJson(wellKnown);
        if (status === 200 && json?.authorization_endpoint && json?.token_endpoint) {
          return {
            authorizationEndpoint: String(json.authorization_endpoint),
            tokenEndpoint: String(json.token_endpoint),
            registrationEndpoint: json.registration_endpoint ? String(json.registration_endpoint) : undefined,
            resource,
            scope: scope ?? normalizeScopes(json.scopes_supported),
          };
        }
      } catch {
        /* coba varian/issuer berikutnya */
      }
    }
  }
  return null;
}

/** Dynamic Client Registration (RFC 7591) — public client + PKCE, tanpa secret. */
async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const { status, json } = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'SiberGate',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_uri: 'https://github.com/sibergate',
    }),
  });
  if (status >= 200 && status < 300 && json?.client_id) return String(json.client_id);
  throw new Error(
    `Dynamic client registration failed (${status}): ${JSON.stringify(json).slice(0, 300)}`,
  );
}

export interface McpOAuthStart {
  authorizationUrl: string;
  redirectUri: string;
}

/**
 * Mulai flow OAuth utk provider MCP: discovery → registration → PKCE → simpan
 * row pending di mcp_oauth → kembalikan URL otorisasi (dibuka browser operator).
 */
export async function startMcpOAuth(providerId: string, mcpEndpointUrl: string): Promise<McpOAuthStart> {
  const db = getDb();
  const redirectUri = mcpOAuthRedirectUri();
  const endpoints = await discoverMcpOAuth(mcpEndpointUrl);

  // Selalu register ulang client (RFC 7591) di tiap start flow — registrasi
  // murah, dan reuse client_id lama rapuh saat server OAuth restart / pindah
  // environment (registry-nya hilang → authorize ditolak invalid_client).
  let clientId: string;
  if (endpoints.registrationEndpoint) {
    clientId = await registerOAuthClient(endpoints.registrationEndpoint, redirectUri);
  } else {
    throw new Error(
      `OAuth server tidak menyediakan dynamic client registration (RFC 7591) — ` +
        `SiberGate tidak bisa mendaftarkan client_id utk ${endpoints.authorizationEndpoint}.`,
    );
  }

  const codeVerifier = base64url(randomBytes(PKCE_VERIFIER_BYTES));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(24));

  db.prepare(
    `INSERT INTO mcp_oauth (provider_id, status, client_id, resource, authorization_endpoint,
       token_endpoint, registration_endpoint, redirect_uri, scope, updated_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       status='pending', client_id=excluded.client_id, resource=excluded.resource,
       authorization_endpoint=excluded.authorization_endpoint, token_endpoint=excluded.token_endpoint,
       registration_endpoint=excluded.registration_endpoint, redirect_uri=excluded.redirect_uri,
       scope=excluded.scope,
       access_token=NULL, refresh_token=NULL, expires_at=NULL, user_info=NULL, last_error=NULL,
       updated_at=datetime('now')`,
  ).run(
    providerId,
    clientId,
    endpoints.resource ?? null,
    endpoints.authorizationEndpoint,
    endpoints.tokenEndpoint,
    endpoints.registrationEndpoint ?? null,
    redirectUri,
    endpoints.scope ?? null,
  );

  pendingFlows.set(state, {
    providerId,
    codeVerifier,
    redirectUri,
    resource: endpoints.resource,
    expiresAt: Date.now() + FLOW_TTL_MS,
  });

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (endpoints.resource) authUrl.searchParams.set('resource', endpoints.resource);
  // Scope: minta eksplisit bila server mendeklarasikan scopes_supported (mis.
  // Kling: generation.create generation.read account.credit.read) supaya token
  // benar-benar berizin generasi; tanpa deklarasi → omit (server pakai default).
  if (endpoints.scope) authUrl.searchParams.set('scope', endpoints.scope);

  return { authorizationUrl: authUrl.href, redirectUri };
}

export interface McpOAuthCallbackResult {
  providerId: string;
  ok: boolean;
  error?: string;
}

/**
 * Selesaikan flow OAuth: verifikasi state → tukar code → simpan token.
 * Dipanggil oleh callback handler gateway (GET /admin/mcp/oauth/callback).
 */
export async function handleMcpOAuthCallback(params: {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}): Promise<McpOAuthCallbackResult> {
  const db = getDb();
  const { code, state, error, errorDescription } = params;

  if (error) {
    const flow = state ? pendingFlows.get(state) : undefined;
    if (flow) {
      db.prepare(
        `UPDATE mcp_oauth SET status='error', last_error=?, updated_at=datetime('now') WHERE provider_id=?`,
      ).run(`authorization denied: ${error}${errorDescription ? ` (${errorDescription})` : ''}`, flow.providerId);
      pendingFlows.delete(state!);
      return { providerId: flow.providerId, ok: false, error: `Authorization denied: ${error}` };
    }
    return { providerId: '', ok: false, error: `Authorization denied: ${error}` };
  }

  if (!code || !state) throw new Error('OAuth callback missing code/state.');
  const flow = pendingFlows.get(state);
  if (!flow) throw new Error('OAuth state tidak dikenali atau kedaluwarsa — ulangi Connect dari admin UI.');
  if (flow.expiresAt < Date.now()) {
    pendingFlows.delete(state);
    throw new Error('Flow OAuth kedaluwarsa — ulangi Connect dari admin UI.');
  }
  pendingFlows.delete(state);

  const row = db.prepare('SELECT * FROM mcp_oauth WHERE provider_id = ?').get(flow.providerId) as any;
  if (!row) throw new Error(`Provider MCP '${flow.providerId}' tidak memiliki sesi OAuth pending.`);

  const tokenResp = await exchangeToken(row.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirectUri,
    client_id: row.client_id,
    code_verifier: flow.codeVerifier,
    ...(flow.resource ? { resource: flow.resource } : {}),
  });

  storeTokens(flow.providerId, tokenResp);
  return { providerId: flow.providerId, ok: true };
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function exchangeToken(tokenEndpoint: string, form: Record<string, string>): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams(form).toString();
  let res: Response;
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (err) {
    throw new Error(`Gagal menghubungi token endpoint OAuth: ${(err as Error).message}`);
  }
  const json = await res.json().catch(() => null) as (OAuthTokenResponse & { error?: string; error_description?: string }) | null;
  if (!res.ok || !json?.access_token) {
    throw new Error(
      `Token exchange gagal (${res.status}): ${json?.error_description ?? json?.error ?? 'unknown error'}`,
    );
  }
  return json;
}

function storeTokens(providerId: string, token: OAuthTokenResponse): void {
  const db = getDb();
  const expiresAt = token.expires_in ? Date.now() + token.expires_in * 1000 - 30_000 : null;
  const payload: StoredTokenPayload = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAt ?? undefined,
  };
  db.prepare(
    `UPDATE mcp_oauth SET
       status='connected', access_token=?, refresh_token=?, expires_at=?, scope=?,
       last_error=NULL, updated_at=datetime('now')
     WHERE provider_id=?`,
  ).run(
    JSON.stringify(encryptJSON(payload)),
    JSON.stringify(encryptJSON({ refreshToken: token.refresh_token ?? '' })),
    expiresAt,
    token.scope ?? null,
    providerId,
  );
}

/** Row mcp_oauth (token tetap terenkripsi — hanya status/endpoints utk display). */
export function getMcpOAuthStatus(providerId: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT * FROM mcp_oauth WHERE provider_id=?').get(providerId) as any;
  if (!row) return null;
  return {
    providerId: row.provider_id,
    status: row.status,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    expiresAt: row.expires_at,
    userInfo: row.user_info ? safeParse(row.user_info) : null,
    lastError: row.last_error,
    hasAccessToken: !!row.access_token,
    hasRefreshToken: !!row.refresh_token,
    updatedAt: row.updated_at,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Ambil access token valid utk provider (refresh otomatis bila expired).
 * Return null bila provider tidak punya sesi OAuth (→ fallback key statis).
 */
export async function getValidMcpAccessToken(providerId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_oauth WHERE provider_id=?').get(providerId) as any;
  if (!row?.access_token) return null;
  let payload: StoredTokenPayload;
  try {
    payload = decryptJSON<StoredTokenPayload>(JSON.parse(row.access_token) as EncryptedBlob);
  } catch {
    return null;
  }
  // Masih valid (buffer 30s) → pakai langsung.
  if (!payload.expiresAt || payload.expiresAt > Date.now() + 30_000) return payload.accessToken;
  const refreshed = await refreshMcpAccessToken(providerId, row);
  return refreshed;
}

/** Paksa refresh (dipakai saat upstream balas 401). */
export async function forceRefreshMcpAccessToken(providerId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_oauth WHERE provider_id=?').get(providerId) as any;
  if (!row) return null;
  return refreshMcpAccessToken(providerId, row);
}

async function refreshMcpAccessToken(providerId: string, row: any): Promise<string | null> {
  let refreshToken = '';
  try {
    const blob = decryptJSON<{ refreshToken?: string }>(JSON.parse(row.refresh_token) as EncryptedBlob);
    refreshToken = blob.refreshToken ?? '';
  } catch {
    refreshToken = '';
  }
  if (!refreshToken) return null;
  try {
    const token = await exchangeToken(row.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: row.client_id,
    });
    // Beberapa AS tidak mengembalikan refresh_token baru — pertahankan lama bila absen.
    if (!token.refresh_token) {
      token.refresh_token = refreshToken;
    }
    storeTokens(providerId, token);
    return token.access_token;
  } catch (err) {
    getDb().prepare(
      `UPDATE mcp_oauth SET last_error=?, updated_at=datetime('now') WHERE provider_id=?`,
    ).run(`refresh gagal: ${(err as Error).message}`.slice(0, 300), providerId);
    return null;
  }
}

/** Hapus sesi OAuth (disconnect). */
export function disconnectMcpOAuth(providerId: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM mcp_oauth WHERE provider_id=?').run(providerId).changes > 0;
}

/** Simpan hasil who_am_i (display). */
export function setMcpOAuthUserInfo(providerId: string, userInfo: unknown): void {
  getDb().prepare(
    `UPDATE mcp_oauth SET user_info=?, updated_at=datetime('now') WHERE provider_id=?`,
  ).run(JSON.stringify(userInfo ?? null), providerId);
}
