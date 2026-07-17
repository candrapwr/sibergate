import { Hono } from 'hono';
import {
  authenticate,
  clearSessionCookieHeader,
  findUserById,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifySession,
} from '@sibergate/core';

/**
 * Auth routes for the admin panel — mounted at /admin/auth/* and intentionally
 * OUTSIDE the admin-key middleware (you can't present the admin key before you
 * log in). These endpoints issue/clear a session cookie used by the Next.js UI.
 *
 * The admin API key still protects /admin/* (providers, routes, etc.) — login
 * here only gates the UI; the proxy injects the admin key for actual data calls.
 */
export function createAuthRouter() {
  const app = new Hono();

  // Login: verify email+password, set a signed session cookie.
  app.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: { message: 'Email and password are required.', type: 'invalid_request_error' } }, 400);
    }
    const user = authenticate(body.email, body.password);
    if (!user) {
      return c.json({ error: { message: 'Invalid email or password.', type: 'authentication_error' } }, 401);
    }
    c.header('Set-Cookie', sessionCookieHeader(user.id));
    return c.json({ user });
  });

  // Logout: clear the session cookie.
  app.post('/logout', (c) => {
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });

  // Who am I? Resolve the session cookie to the current user (or 401).
  app.get('/me', (c) => {
    const cookie = c.req.header('cookie') ?? '';
    const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    const token = match?.[1];
    const userId = verifySession(token);
    if (!userId) return c.json({ error: { message: 'Not authenticated.', type: 'authentication_error' } }, 401);
    const user = findUserById(userId);
    if (!user || user.status !== 'active') {
      return c.json({ error: { message: 'Not authenticated.', type: 'authentication_error' } }, 401);
    }
    return c.json({ user });
  });

  return app;
}
