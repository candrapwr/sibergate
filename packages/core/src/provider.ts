import type { Provider, RouteModality } from './types.js';
import { chat } from './adapters/chat.js';
import { image } from './adapters/image.js';
import { speech } from './adapters/speech.js';
import { transcribe } from './adapters/transcribe.js';
import { embed } from './adapters/embed.js';
import { music } from './adapters/music.js';
import { generic } from './adapters/generic.js';
import { responses } from './adapters/responses.js';
import { toolsText } from './adapters/tools-text.js';

/**
 * Polymorphic provider adapter.
 *
 * Each modality (chat, image, speech, transcribe, embed, music) has its own
 * adapter that knows the upstream endpoint + request/response shape. The
 * dispatcher here picks the right one based on the route's modality and builds
 * the upstream URL from the provider's `endpoints` map.
 *
 * The endpoint template may contain `{model}`, which is substituted with the
 * target's model id (used by inference-style providers like DeepInfra).
 */

export interface AdapterCall {
  provider: Provider;
  model: string;
  /** The original client request body (already validated upstream). */
  body: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * Client headers to pass through to the upstream, after filtering by the
   * allowlist. Set by the gateway handler before dispatch; undefined = none.
   * Secrets (Authorization, cookie, …) are NEVER included here — the gateway
   * filters them before populating this field.
   */
  passthroughHeaders?: Record<string, string>;
  /**
   * Optional undici dispatcher (ProxyAgent) to route this upstream call through
   * an outbound proxy. Set by the engine when the route's provider is bound to
   * an active proxy pool. undefined = direct fetch (no proxy). Type loose (`any`)
   * to avoid forcing all adapter files to import undici types.
   */
  dispatcher?: unknown;
}

const ADAPTERS: Record<RouteModality, (call: AdapterCall) => Promise<Response>> = {
  chat,
  image,
  speech,
  transcribe,
  embed,
  music,
  generic,
  responses,
  'tools-text': toolsText,
  'tools-text-stream': toolsText,
  'tools-text-nonstream': toolsText,
};

/**
 * Build the upstream URL for a (provider, modality, model) combination.
 *
 * Recognized placeholders in the endpoint template:
 *   {model}    → the target's model id (URL-encoded)
 *   {model_id} → same as {model}
 *   {path}     → the request path suffix (generic modality only; NOT encoded,
 *                so it may carry its own query string). Lets a single generic
 *                endpoint fan out to many upstream paths.
 */
export function resolveEndpoint(
  provider: Provider,
  modality: RouteModality,
  model: string,
  path?: string,
): string | null {
  const tpl = provider.endpoints[modality];
  if (!tpl) return null; // provider does not support this modality
  return tpl
    .replace('{model}', encodeURIComponent(model))
    .replace('{model_id}', encodeURIComponent(model))
    .replace('{path}', path ?? '');
}

/** Build the absolute upstream URL (baseUrl + endpoint). */
export function upstreamUrl(
  provider: Provider,
  modality: RouteModality,
  model: string,
  path?: string,
): string {
  const ep = resolveEndpoint(provider, modality, model, path);
  if (!ep) throw new GatewayCallError('unsupported', `${provider.id} has no endpoint for modality '${modality}'`);
  // Handle templates that are absolute vs relative to baseUrl.
  if (/^https?:\/\//.test(ep)) return ep;
  const base = provider.baseUrl.replace(/\/+$/, '');
  // Avoid doubling a version segment when baseUrl already ends with one (e.g.
  // "/v1", "/v1beta") and the endpoint template starts with the same segment.
  // The previous /v1-only check left Gemini ("/v1beta") doubled → upstream 404.
  const baseVersion = base.match(/\/v\d+[A-Za-z]*$/)?.[0];
  if (baseVersion && ep.startsWith(baseVersion + '/')) {
    return `${base}${ep.slice(baseVersion.length)}`; // drop the duplicated version
  }
  return `${base}${ep.startsWith('/') ? '' : '/'}${ep}`;
}

/** Redact secret header values for safe storage in trace files. */
function redactUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const REDACT = /^(authorization|x-api-key|api-key|proxy-authorization|x-auth-token)$/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT.test(k)) {
      const scheme = v.split(' ')[0];
      out[k] = scheme && scheme !== v ? `${scheme} ***` : '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Common request builder shared by all adapters. */
export async function sendUpstream(opts: {
  url: string;
  method?: string;
  provider: Provider;
  body: BodyInit;
  signal: AbortSignal;
  contentType?: string;
  /** Filtered client headers to forward to the upstream (allowlist only). */
  passthroughHeaders?: Record<string, string>;
  /** Optional undici dispatcher (ProxyAgent) to route through outbound proxy. */
  dispatcher?: unknown;
}): Promise<Response> {
  const { provider, body, signal } = opts;
  let url = opts.url;
  // Build upstream headers: Content-Type, provider custom headers, then any
  // allowlisted client headers (passthrough). Passthrough comes LAST so it can
  // override Content-Type if the client explicitly set it (e.g. multipart).
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/json',
    ...provider.headers,
    ...(opts.passthroughHeaders ?? {}),
  };
  // Attach credentials according to the provider's auth scheme.
  // 'none' skips auth entirely (public upstreams); the others inject the key.
  if (provider.apiKey && provider.authScheme !== 'none') {
    switch (provider.authScheme) {
      case 'x-api-key':
        headers['x-api-key'] = provider.apiKey;
        break;
      case 'query':
        // Append ?api_key= (or &api_key=) to the URL.
        url += (url.includes('?') ? '&' : '?') + `api_key=${encodeURIComponent(provider.apiKey)}`;
        break;
      case 'basic': {
        // key may be "user:pass" already, or a bare token treated as the password.
        const raw = provider.apiKey.includes(':') ? provider.apiKey : `:${provider.apiKey}`;
        headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
        break;
      }
      case 'bearer':
      default:
        headers.Authorization = `Bearer ${provider.apiKey}`;
        break;
    }
  }

  let res: Response;
  try {
    // `dispatcher` (ProxyAgent) routes this upstream call through an outbound
    // proxy when set; undefined = direct fetch. Spread conditionally so we
    // don't pollute the RequestInit when no proxy is in use.
    res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers,
      body,
      signal,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    });
  } catch (err) {
    const e = err as Error;
    const cause = (e as Error & { cause?: { code?: string; name?: string; message?: string } }).cause;
    const causeCode = cause?.code;
    const causeDetail = causeCode || cause?.name || cause?.message
      ? ` (${[causeCode ?? cause?.name, cause?.message].filter(Boolean).join(': ')})`
      : '';
    if (
      e.name === 'AbortError'
      || causeCode === 'UND_ERR_HEADERS_TIMEOUT'
      || causeCode === 'UND_ERR_BODY_TIMEOUT'
      || causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      throw new GatewayCallError('timeout', `Request timed out${causeDetail}.`);
    }
    throw new GatewayCallError('network', `Failed to reach ${provider.id}: ${e.message}${causeDetail}`);
  }

  if (!res.ok) {
    let detail = '';
    let rawBody = '';
    try {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const parsed = await res.clone().json();
        // Error body dapat berupa object {error:{message}} atau ARRAY
        // [{"error":{...}}] (Gemini OpenAI-compat sering balas array). Resolve
        // ke elemen error pertama supaya detail message tidak hilang.
        const errBody = (Array.isArray(parsed) ? parsed[0] : parsed) as
          | { error?: { message?: string } | string }
          | undefined;
        detail = errBody?.error
          ? typeof errBody.error === 'string'
            ? errBody.error
            : errBody.error.message ?? ''
          : typeof parsed === 'string'
            ? parsed
            : '';
        rawBody = JSON.stringify(parsed).slice(0, 1000);
      } else {
        rawBody = (await res.clone().text()).slice(0, 1000);
        detail = rawBody.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    // Surface the failing URL + response so operators can diagnose 404/400 from
    // the upstream (e.g. doubled /v1beta path). Logged to console AND attached
    // to the thrown error so it lands in the `requests.metadata` audit log.
    const redactedUrl = url.replace(/(api_key|key|token|access_token)=[^&]+/gi, '$1=***');
    console.warn(
      `[sibergate] upstream ${provider.id} ${res.status} ${res.statusText}\n` +
        `  URL: ${redactedUrl}\n` +
        `  body: ${rawBody || '(empty)'}`,
    );
    const code = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'client_error';
    throw new GatewayCallError(
      code,
      `${provider.id} returned ${res.status}${detail ? `: ${detail}` : ''}`.slice(0, 400),
      res.status,
      { upstreamUrl: redactedUrl, upstreamStatus: res.status, upstreamBody: rawBody || null, upstreamRequestBody: typeof body === 'string' ? body : null, upstreamRequestHeaders: redactUpstreamHeaders(headers) },
    );
  }

  // Cloudflare/CDN/proxy error pages: upstream can reply with status 200 OK
  // (interstitial / cached challenge) OR a 5xx, but the body is an HTML error
  // page instead of the JSON/SSE the API should return. res.ok being true lets
  // these slip past the check above and the raw HTML gets forwarded verbatim to
  // the client. Detect by Content-Type and convert to a proper GatewayCallError
  // so the engine can fail over (or the gateway returns an OpenAI-compat JSON
  // error). No SiberGate adapter legitimately expects text/html.
  const responseCt = res.headers.get('content-type') ?? '';
  if (responseCt.includes('text/html')) {
    let htmlBody = '';
    try {
      htmlBody = (await res.clone().text()).slice(0, 1000);
    } catch {
      /* ignore */
    }
    const title = htmlBody.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    const htmlRedactedUrl = url.replace(/(api_key|key|token|access_token)=[^&]+/gi, '$1=***');
    console.warn(
      `[sibergate] upstream ${provider.id} returned HTML (not JSON/SSE)\n` +
        `  status: ${res.status}\n  URL: ${htmlRedactedUrl}\n  body: ${htmlBody.slice(0, 200) || '(empty)'}`,
    );
    throw new GatewayCallError(
      'server_error',
      `${provider.id} returned an HTML page instead of an API response${title ? `: ${title}` : ''} (likely a proxy/CDN error page)`.slice(0, 400),
      res.status,
      { upstreamUrl: htmlRedactedUrl, upstreamStatus: res.status, upstreamBody: htmlBody || null, upstreamRequestBody: typeof body === 'string' ? body : null, upstreamRequestHeaders: redactUpstreamHeaders(headers) },
    );
  }
  return res;
}

/** Dispatch a call to the right adapter for the route's modality. */
export function callProvider(call: AdapterCall & { modality: RouteModality }): Promise<Response> {
  const adapter = ADAPTERS[call.modality];
  if (!adapter) throw new GatewayCallError('unsupported', `No adapter for modality '${call.modality}'`);
  return adapter(call);
}

/** Typed upstream error with a code so the engine can decide whether to retry. */
export class GatewayCallError extends Error {
  readonly code: string;
  readonly status?: number;
  servedBy?: { provider: string; model: string; keyId?: string | null };
  /** Failover trail accumulated before this error was thrown (for audit logging). */
  trail?: import('./engine.js').FailoverStep[];
  /** Diagnostics from the failing upstream call (URL, status, response & request body & headers). */
  upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string, string> | null };
  constructor(
    code: string,
    message: string,
    status?: number,
    upstream?: {
      upstreamUrl?: string;
      upstreamStatus?: number;
      upstreamBody?: string | null;
      upstreamRequestBody?: string | null;
      upstreamRequestHeaders?: Record<string, string> | null;
    },
  ) {
    super(message);
    this.name = 'GatewayCallError';
    this.code = code;
    this.status = status;
    if (upstream) {
      this.upstream = {
        url: upstream.upstreamUrl,
        status: upstream.upstreamStatus,
        body: upstream.upstreamBody,
        requestBody: upstream.upstreamRequestBody,
        requestHeaders: upstream.upstreamRequestHeaders,
      };
    }
  }
}

/**
 * Should the engine fail over to the next target given this error?
 *
 * Each route target is a distinct (provider, model) pair, so almost ANY
 * upstream error is worth trying the next target for — a 400 "model not found"
 * from one provider doesn't mean the next provider's model will also fail.
 * The only case we DON'T fail over is when the route itself has no targets.
 */
export function isFailoverable(err: unknown): boolean {
  if (!(err instanceof GatewayCallError)) return false;
  // 'no_targets' / 'all_failed' mean there's nothing left to try.
  if (err.code === 'no_targets' || err.code === 'all_failed') return false;
  // Everything else (timeout, network, rate-limited, server errors, AND client
  // errors like 400/404 "model not found") → try the next target.
  return true;
}
