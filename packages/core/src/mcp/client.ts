import type { Provider } from '../types.js';
import { GatewayCallError } from '../provider.js';
import { pushConsoleLog } from '../console-log.js';
import { forceRefreshMcpAccessToken, getValidMcpAccessToken } from './oauth.js';

/**
 * MCP (Model Context Protocol) client — JSON-RPC 2.0 over Streamable HTTP
 * (MCP spec 2025-06-18 / 2025-03-26).
 *
 * Provider protocol='mcp' memakai modul ini sebagai pengganti sendUpstream():
 * baseUrl = MCP endpoint, autentikasi = OAuth (tabel mcp_oauth, dipakai bila
 * ada; mis. Kling) atau key statis (authScheme), session di-cache per provider
 * dan re-init otomatis saat expired (404) / token OAuth ditolak (401).
 *
 * Respons server dapat berupa application/json (satu pesan) atau
 * text/event-stream (pesan JSON-RPC dibungkus event SSE — diambil pesan dengan
 * id yang cocok, notifikasi lain diabaikan, lalu stream dibatalkan).
 */

/** Tool descriptor hasil tools/list. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Hasil tools/call. */
export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpSession {
  /** Dari response header initialize; null = server stateless. */
  sessionId: string | null;
  protocolVersion: string;
}

/** Kode error internal (tidak pernah keluar dari modul ini). */
const ERR_SESSION_EXPIRED = 'mcp_session_expired';
const ERR_PROTOCOL_VERSION = 'mcp_protocol_version';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
const CLIENT_INFO = { name: 'SiberGate', version: '1.0.0' };

/** Client aktif per provider; fingerprint berubah → client baru (session baru). */
const clientCache = new Map<string, { fingerprint: string; client: McpClient }>();

function clientFingerprint(provider: Provider): string {
  return JSON.stringify([provider.baseUrl, provider.authScheme, provider.apiKey, provider.headers]);
}

function getClient(provider: Provider): McpClient {
  const fingerprint = clientFingerprint(provider);
  const cached = clientCache.get(provider.id);
  if (cached && cached.fingerprint === fingerprint) return cached.client;
  const client = new McpClient(provider);
  clientCache.set(provider.id, { fingerprint, client });
  return client;
}

/** Hapus session cache provider (disconnect OAuth / delete provider). */
export function resetMcpClient(providerId: string): void {
  clientCache.delete(providerId);
}

export interface McpCallOptions {
  signal?: AbortSignal;
  /** undici dispatcher (outbound proxy) — sama seperti sendUpstream. */
  dispatcher?: unknown;
}

/** List tools dari server MCP (menangani pagination cursor). */
export async function mcpToolsList(provider: Provider, opts?: McpCallOptions): Promise<McpToolInfo[]> {
  const result = await mcpRequest(provider, 'tools/list', {}, opts, true) as
    | { tools?: McpToolInfo[]; nextCursor?: string }
    | undefined;
  const tools = [...(result?.tools ?? [])];
  let cursor = result?.nextCursor;
  // Pagination: kumpulkan semua halaman (bounded 50 utk safety loop).
  for (let i = 0; cursor && i < 50; i++) {
    const page = await mcpRequest(provider, 'tools/list', { cursor }, opts, true) as
      | { tools?: McpToolInfo[]; nextCursor?: string }
      | undefined;
    if (page?.tools) tools.push(...page.tools);
    cursor = page?.nextCursor;
  }
  return tools;
}

/** Panggil sebuah tool (tools/call). */
export async function mcpToolsCall(
  provider: Provider,
  tool: string,
  args: Record<string, unknown>,
  opts?: McpCallOptions,
): Promise<McpToolResult> {
  const result = await mcpRequest(provider, 'tools/call', { name: tool, arguments: args }, opts, true) as
    | (McpToolResult & { nextCursor?: unknown })
    | undefined;
  return {
    content: Array.isArray(result?.content) ? (result!.content as Array<Record<string, unknown>>) : [],
    structuredContent: result?.structuredContent,
    isError: !!result?.isError,
  };
}

/**
 * Kirim satu request JSON-RPC. Public entry point semua operasi MCP.
 * retrySession = true → retry otomatis saat session expired / token 401.
 */
export async function mcpRequest(
  provider: Provider,
  method: string,
  params: Record<string, unknown>,
  opts?: McpCallOptions,
  retrySession = false,
): Promise<unknown> {
  const client = getClient(provider);
  try {
    return await client.request(method, params, opts);
  } catch (err) {
    const ge = err as GatewayCallError;
    if (!retrySession || !(ge instanceof GatewayCallError)) throw err;
    if (ge.code === ERR_SESSION_EXPIRED || ge.status === 401) {
      // Sekali retry: 404-session → re-init; 401 → refresh token OAuth dulu.
      if (ge.status === 401) {
        const refreshed = await forceRefreshMcpAccessToken(provider.id).catch(() => null);
        if (!refreshed) {
          throw new GatewayCallError(
            'client_error',
            `MCP OAuth token ${provider.id} ditolak (401) dan refresh gagal — reconnect via admin UI.`,
            401,
          );
        }
      }
      return client.request(method, params, opts, /* freshSession */ true);
    }
    throw err;
  }
}

/* ─────────────────────────── implementasi ─────────────────────────── */

let nextRequestId = 1;

class McpClient {
  private session: McpSession | null = null;
  private initPromise: Promise<McpSession> | null = null;

  constructor(private provider: Provider) {}

  private async ensureSession(opts?: McpCallOptions, force = false): Promise<McpSession> {
    if (force) this.session = null;
    if (this.session) return this.session;
    this.initPromise ??= this.initialize(opts)
      .then((session) => {
        this.session = session;
        return session;
      })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  private async initialize(opts?: McpCallOptions): Promise<McpSession> {
    let lastError: unknown = null;
    for (const protocolVersion of PROTOCOL_VERSIONS) {
      try {
        const msg = await this.post(
          {
            jsonrpc: '2.0',
            id: nextRequestId++,
            method: 'initialize',
            params: { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
          },
          { opts, expectResponse: true },
        );
        if (!msg) throw new GatewayCallError('server_error', `MCP initialize: no response from ${this.provider.id}`);
        throwIfRpcError(this.provider.id, msg.error, /* versionNegotiation */ true);
        const result = msg.result as { protocolVersion?: string } | undefined;
        const session: McpSession = {
          sessionId: this.lastSessionId,
          protocolVersion: result?.protocolVersion ?? protocolVersion,
        };
        pushConsoleLog(
          'info', 'mcp',
          `initialized ${this.provider.id} (protocol ${session.protocolVersion}${session.sessionId ? `, session ${session.sessionId.slice(0, 12)}…` : ', stateless'})`,
          { provider: this.provider.id, protocolVersion: session.protocolVersion },
        );
        // Notification initialized (spec: wajib setelah initialize). 202/no-body
        // wajar; kegagalan tidak fatal (server stateless kadang menolak).
        await this.post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { opts, session, expectResponse: false },
        ).catch(() => undefined);
        return session;
      } catch (err) {
        lastError = err;
        // Hanya error negosiasi versi yang layak dicoba dgn versi lebih lama;
        // error network/auth langsung gagal.
        if (!(err instanceof GatewayCallError) || err.code !== ERR_PROTOCOL_VERSION) throw err;
      }
    }
    throw lastError ?? new GatewayCallError('unsupported', `MCP initialize failed for ${this.provider.id}`);
  }

  async request(method: string, params: Record<string, unknown>, opts?: McpCallOptions, freshSession = false): Promise<unknown> {
    const session = await this.ensureSession(opts, freshSession);
    const msg = await this.post(
      { jsonrpc: '2.0', id: nextRequestId++, method, params },
      { opts, session, expectResponse: true },
    );
    if (!msg) return undefined;
    throwIfRpcError(this.provider.id, msg.error, false);
    return msg.result;
  }

  private lastSessionId: string | null = null;

  /**
   * Satu POST JSON-RPC ke MCP endpoint. Menangani: auth (OAuth menang atas
   * key statis), header session + versi protokol, respons JSON vs SSE, dan
   * mapping error HTTP/JSON-RPC ke GatewayCallError.
   */
  private async post(
    message: Record<string, unknown>,
    o: {
      opts?: McpCallOptions;
      session?: McpSession;
      expectResponse: boolean;
    },
  ): Promise<JsonRpcResponse | null> {
    const provider = this.provider;
    let url = provider.baseUrl;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...provider.headers,
    };
    if (o.session?.sessionId) headers['Mcp-Session-Id'] = o.session.sessionId;
    if (o.session) headers['MCP-Protocol-Version'] = o.session.protocolVersion;
    // Auth: OAuth (bila ada sesi terhubung) menang atas key statis.
    const oauthToken = await getValidMcpAccessToken(provider.id).catch(() => null);
    if (oauthToken) {
      headers.Authorization = `Bearer ${oauthToken}`;
    } else if (provider.apiKey && provider.authScheme !== 'none') {
      switch (provider.authScheme) {
        case 'x-api-key':
          headers['x-api-key'] = provider.apiKey;
          break;
        case 'basic': {
          const raw = provider.apiKey.includes(':') ? provider.apiKey : `:${provider.apiKey}`;
          headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
          break;
        }
        case 'query':
          url += (url.includes('?') ? '&' : '?') + `api_key=${encodeURIComponent(provider.apiKey)}`;
          break;
        case 'bearer':
        default:
          headers.Authorization = `Bearer ${provider.apiKey}`;
          break;
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: o.opts?.signal,
        ...(o.opts?.dispatcher ? { dispatcher: o.opts.dispatcher as never } : {}),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new GatewayCallError('timeout', `MCP request aborted (timeout/disconnect): ${provider.id}`);
      }
      throw new GatewayCallError('network', `Failed to reach MCP server ${provider.id}: ${e.message}`);
    }

    // 202 tanpa body = notification diterima (spec Streamable HTTP).
    if (res.status === 202) {
      res.body?.cancel().catch(() => undefined);
      return null;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // 404 saat session aktif = session expired (spec Streamable HTTP).
      if (res.status === 404 && o.session?.sessionId) {
        throw new GatewayCallError(ERR_SESSION_EXPIRED, `MCP session expired for ${provider.id}`);
      }
      const code = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'client_error';
      throw new GatewayCallError(
        code,
        `MCP server ${provider.id} returned ${res.status}: ${bodyText.slice(0, 200)}`,
        res.status,
        {
          upstreamUrl: url.replace(/(api_key|key|token)=[^&]+/gi, '$1=***'),
          upstreamStatus: res.status,
          upstreamBody: bodyText.slice(0, 1000) || null,
          upstreamRequestBody: JSON.stringify(message).slice(0, 2000),
          upstreamRequestHeaders: redactHeaders(headers),
        },
      );
    }

    const newSessionId = res.headers.get('mcp-session-id');
    if (newSessionId) this.lastSessionId = newSessionId;

    const contentType = res.headers.get('content-type') ?? '';

    // Notification (expectResponse=false): server kadang balas 200 dgn SSE
    // channel terbuka — batalkan body supaya koneksi tidak menggantung.
    if (!o.expectResponse) {
      res.body?.cancel().catch(() => undefined);
      return null;
    }

    if (contentType.includes('text/event-stream')) {
      const msg = await readSseResponse(res, message.id as number | string);
      throwIfRpcError(provider.id, msg.error, false);
      return msg;
    }
    const json = (await res.json().catch(() => null)) as JsonRpcResponse | null;
    if (!json) {
      throw new GatewayCallError(
        'server_error',
        `MCP server ${provider.id} returned a non-JSON body (content-type: ${contentType || 'unknown'})`,
      );
    }
    return json;
  }
}

/**
 * Parse SSE sampai menemukan pesan JSON-RPC dengan id yang diminta, lalu
 * batalkan stream (server boleh keep-alive utk notifikasi lanjutan).
 */
async function readSseResponse(res: Response, matchId: number | string): Promise<JsonRpcResponse> {
  const reader = res.body?.getReader();
  if (!reader) throw new GatewayCallError('server_error', 'MCP server returned an SSE response with no body');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data:[ ]?/, ''))
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(data) as JsonRpcResponse;
        } catch {
          continue; // event non-JSON (ping dsb.)
        }
        if (msg.id !== undefined && msg.id !== null && msg.id === matchId) return msg;
        // Notifikasi/request server lain → diabaikan (hanya respons yg dicari).
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  throw new GatewayCallError(
    'server_error',
    `MCP SSE stream ended without a response for request id ${matchId}`,
  );
}

function throwIfRpcError(providerId: string, error: JsonRpcResponse['error'], versionNegotiation: boolean): void {
  if (!error) return;
  // Saat initialize: error apa pun dicoba sebagai penolakan versi protokol
  // supaya fallback ke versi lebih lama jalan (server lama menolak 2025-06-18).
  if (versionNegotiation) {
    throw new GatewayCallError(
      ERR_PROTOCOL_VERSION,
      `MCP initialize rejected by ${providerId} (${error.code}): ${error.message}`,
      undefined,
      { upstreamBody: JSON.stringify(error).slice(0, 500) },
    );
  }
  throw new GatewayCallError(
    'client_error',
    `MCP server ${providerId} error ${error.code}: ${error.message}`,
    undefined,
    { upstreamBody: JSON.stringify(error).slice(0, 1000) },
  );
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const REDACT = /^(authorization|x-api-key|api-key|x-auth-token|mcp-session-id)$/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = REDACT.test(k) ? '***' : v;
  return out;
}
