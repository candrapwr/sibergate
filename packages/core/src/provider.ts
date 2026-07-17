import type { Provider, RouteModality } from './types.js';
import { chat } from './adapters/chat.js';
import { image } from './adapters/image.js';
import { speech } from './adapters/speech.js';
import { transcribe } from './adapters/transcribe.js';
import { embed } from './adapters/embed.js';
import { music } from './adapters/music.js';

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
}

const ADAPTERS: Record<RouteModality, (call: AdapterCall) => Promise<Response>> = {
  chat,
  image,
  speech,
  transcribe,
  embed,
  music,
};

/** Build the upstream URL for a (provider, modality, model) combination. */
export function resolveEndpoint(provider: Provider, modality: RouteModality, model: string): string | null {
  const tpl = provider.endpoints[modality];
  if (!tpl) return null; // provider does not support this modality
  return tpl.replace('{model}', encodeURIComponent(model)).replace('{model_id}', encodeURIComponent(model));
}

/** Build the absolute upstream URL (baseUrl + endpoint). */
export function upstreamUrl(provider: Provider, modality: RouteModality, model: string): string {
  const ep = resolveEndpoint(provider, modality, model);
  if (!ep) throw new GatewayCallError('unsupported', `${provider.id} has no endpoint for modality '${modality}'`);
  // Handle templates that are absolute vs relative to baseUrl.
  if (/^https?:\/\//.test(ep)) return ep;
  const base = provider.baseUrl.replace(/\/+$/, '');
  // Avoid doubling the /v1 segment when baseUrl already ends with /v1 and the
  // endpoint template also starts with /v1 (common for OpenAI-compat providers
  // whose baseUrl includes the version).
  if (/(\/v\d+)$/.test(base) && ep.startsWith('/v1/')) {
    return `${base}${ep.slice(3)}`; // drop the leading "/v1" from the endpoint
  }
  return `${base}${ep.startsWith('/') ? '' : '/'}${ep}`;
}

/** Common request builder shared by all adapters. */
export async function sendUpstream(opts: {
  url: string;
  method?: string;
  provider: Provider;
  body: BodyInit;
  signal: AbortSignal;
  contentType?: string;
}): Promise<Response> {
  const { url, provider, body, signal } = opts;
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/json',
    ...provider.headers,
  };
  if (provider.apiKey) {
    if (provider.authScheme === 'x-api-key') headers['x-api-key'] = provider.apiKey;
    else headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'POST', headers, body, signal });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new GatewayCallError('timeout', 'Request timed out.');
    throw new GatewayCallError('network', `Failed to reach ${provider.id}: ${e.message}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const errBody = (await res.clone().json()) as { error?: { message?: string } | string };
        detail = typeof errBody.error === 'string' ? errBody.error : errBody.error?.message ?? '';
      } else {
        detail = (await res.clone().text()).slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    const code = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'client_error';
    throw new GatewayCallError(
      code,
      `${provider.id} returned ${res.status}${detail ? `: ${detail}` : ''}`.slice(0, 400),
      res.status,
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
  servedBy?: { provider: string; model: string };
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'GatewayCallError';
    this.code = code;
    this.status = status;
  }
}

/** Should the engine fail over to the next target given this error? */
export function isFailoverable(err: unknown): boolean {
  if (!(err instanceof GatewayCallError)) return false;
  if (['timeout', 'network', 'rate_limited', 'server_error', 'unsupported'].includes(err.code)) return true;
  const status = err.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return true; // per-provider keys
    if (status >= 500) return true;
  }
  return false;
}
