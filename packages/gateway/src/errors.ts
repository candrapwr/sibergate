import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** OpenAI-compatible error body. */
export interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

/**
 * Upstream error shape thrown by the engine (GatewayCallError) and caught by
 * every route handler. Kept loose so it spreads cleanly without importing core.
 */
interface UpstreamError extends Error {
  code?: string;
  status?: number;
}

/**
 * Map an upstream error to the HTTP status returned to the client.
 *
 * Critical distinction vs. a naive `e.status ?? 502`:
 *  - Upstream TIMEOUT (e.code === 'timeout'): the gateway itself is healthy,
 *    only the upstream was slow → **504 Gateway Timeout**. Returning 502 here
 *    makes CDNs (e.g. Cloudflare) replace the clean JSON error with their own
 *    HTML "Bad gateway" page, because they treat 502 from the origin as "the
 *    origin is broken". 504 is a valid origin response and is forwarded as-is.
 *  - Client disconnect (clientAborted): 499 (nginx convention).
 *  - Otherwise: the upstream's status, or 502 if none (e.g. network failure).
 */
export function mapUpstreamErrorStatus(e: UpstreamError, clientAborted = false): number {
  if (clientAborted) return 499;
  if (e.code === 'timeout') return 504;
  return e.status ?? 502;
}

export function errorResponse(
  c: Context,
  status: number,
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
) {
  const body: ErrorBody = { error: { message, type, param, code } };
  return c.json(body, status as ContentfulStatusCode);
}
