import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { extractBearer } from '@sibergate/core';

/**
 * Admin auth — separate from the client API key system.
 *
 * Uses a single admin token (SIBERGATE_ADMIN_KEY env). If unset, one is
 * auto-generated on boot and printed once, then stored in process env so it
 * stays stable for the process lifetime. Admin endpoints are mounted under
 * /admin/* and protected by this middleware.
 *
 * The admin key is intentionally NOT stored in the DB — it's an operator
 * secret, distinct from client `sg_live_*` keys used to call /v1/*.
 */
export function getOrCreateAdminKey(): string {
  const existing = process.env.SIBERGATE_ADMIN_KEY;
  if (existing && existing.length >= 16) return existing;
  const generated = `sg_admin_${randomBytes(24).toString('hex')}`;
  process.env.SIBERGATE_ADMIN_KEY = generated;
  console.log(`\n🔐 Admin API key (auto-generated): ${generated}\n   Set SIBERGATE_ADMIN_KEY in .env to pin it.\n`);
  return generated;
}

export function adminAuthMiddleware(adminKey: string): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token || token !== adminKey) {
      return c.json(
        {
          error: {
            message: 'Invalid or missing admin key.',
            type: 'authentication_error',
            param: null,
            code: 'invalid_admin_key',
          },
        },
        401,
      );
    }
    await next();
  };
}
