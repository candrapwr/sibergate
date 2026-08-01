import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { extractBearer, getDb, hashApiKey, touchApiKey, pushConsoleLog } from '@sibergate/core';

/** Vars attached to each request context. */
export interface Vars {
  requestId: string;
  startedAt: number;
  apiKeyId: string | null;
}

/**
 * Auth middleware: Bearer token → sha256 → lookup in api_keys table.
 *
 * If no api_keys exist in the DB yet, auth is OPEN (so the gateway is usable
 * right after starting, before seeding). Once seeded, requests must present a
 * valid key.
 */
export function authMiddleware(): MiddlewareHandler<{ Variables: Vars }> {
  // Preload key count once per process to decide open vs enforced mode.
  let keyCount = -1;
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    // Public paths + admin + auth (these have their own auth handling).
    if (path === '/' || path === '/health' || path.startsWith('/admin') || path.startsWith('/auth')) {
      await next();
      return;
    }
    if (keyCount === -1) {
      keyCount = (getDb().prepare('SELECT COUNT(*) as c FROM api_keys').get() as { c: number }).c;
    }
    // Open mode when no keys configured.
    if (keyCount === 0) {
      await next();
      return;
    }
    const token = extractBearer(c.req.header('authorization'));
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    if (!token) {
      pushConsoleLog('error', 'auth', `missing API key on ${c.req.method} ${path}`, {
        requestId: c.get('requestId'), method: c.req.method, path, clientIp, reason: 'missing_key',
      });
      return c.json(
        {
          error: {
            message: 'Missing API key. Provide `Authorization: Bearer sg_live_...`.',
            type: 'authentication_error',
            param: null,
            code: 'invalid_api_key',
          },
        },
        401,
      );
    }
    const row = getDb()
      .prepare('SELECT id, enabled FROM api_keys WHERE key_hash = ?')
      .get(hashApiKey(token)) as { id: string; enabled: number } | undefined;
    if (!row || row.enabled !== 1) {
      pushConsoleLog('error', 'auth', `invalid API key on ${c.req.method} ${path}`, {
        requestId: c.get('requestId'), method: c.req.method, path, clientIp,
        reason: !row ? 'unknown_key' : 'disabled_key',
      });
      return c.json(
        { error: { message: 'Invalid API key.', type: 'authentication_error', param: null, code: 'invalid_api_key' } },
        401,
      );
    }
    c.set('apiKeyId', row.id);
    touchApiKey(row.id);
    await next();
  };
}

/** Attach a request id + start timestamp. */
export const requestIdMiddleware: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const id = c.req.header('x-request-id') || randomUUID();
  c.set('requestId', id);
  c.set('startedAt', performance.now());
  c.header('x-request-id', id);
  await next();
};
