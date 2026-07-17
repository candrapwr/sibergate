import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** OpenAI-compatible error body. */
export interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
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
