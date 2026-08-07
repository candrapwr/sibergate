import { serve } from '@hono/node-server';
import { ConfigStore, getDb, loadDotEnv, pushConsoleLog, startHealthMonitor } from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { createApp } from './routes.js';
import { createAdminRouter } from './admin-routes.js';
import { createAuthRouter } from './auth-routes.js';
import { createCustomScriptPublicRouter, createCustomScriptAdminRouter } from './custom-routes.js';
import { createProxyAdminRouter } from './proxy-routes.js';
import { getOrCreateAdminKey } from './admin-middleware.js';

function readTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * SiberGate gateway entry point.
 *
 * Boot:
 *   1. Load .env
 *   2. Open SQLite (auto-migrates schema)
 *   3. Build a ConfigStore (loads + caches master data from DB; hot-reloadable)
 *   4. Wire the public app (OpenAI-compat /v1/*) + admin app (/admin/*)
 *   5. Serve
 */
async function main() {
  await loadDotEnv();

  getDb();
  const configStore = new ConfigStore(getDb());
  const adminKey = getOrCreateAdminKey();

  const port = Number(process.env.SIBERGATE_PORT ?? 8787);
  const host = process.env.SIBERGATE_HOST ?? '0.0.0.0';

  // Public OpenAI-compatible app. It reads live config from the store, so admin
  // mutations take effect immediately without a restart.
  const app = createApp(configStore);
  app.use('*', requestIdMiddleware);
  app.use('*', authMiddleware());

  // Admin REST API (separate auth).
  app.route('/admin', createAdminRouter(configStore));

  // Auth routes for the admin panel (login/logout/me) — no admin-key required;
  // these issue a session cookie that gates the Next.js UI. Mounted under /auth
  // (separate from /admin) so the admin-key middleware never intercepts them.
  app.route('/auth', createAuthRouter());

  // Custom Scripts — user-built Node.js scripts exposed as HTTP endpoints.
  // Public execution surface (needs a client sg_live_* key via authMiddleware)
  // + admin CRUD/test surface (needs admin key). Each script becomes a URL
  // (/api/custom/<id>) you can register as a provider target, reusing the
  // engine + failover unchanged.
  app.route('/api/custom', createCustomScriptPublicRouter());
  app.route('/admin/custom-scripts', createCustomScriptAdminRouter(configStore));

  // Proxy Layer — outbound proxy pools selektif per provider (HTTP/HTTPS/SOCKS5).
  // Admin CRUD + test + logs. Routing engine inject dispatcher via resolveProxy.
  app.route('/admin/proxy', createProxyAdminRouter(configStore));
  // Background health monitor (active ping) — unref supaya tidak hold event loop.
  startHealthMonitor();

  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `Not found: ${c.req.method} ${new URL(c.req.url).pathname}`,
          type: 'invalid_request_error',
          param: null,
          code: 'not_found',
        },
      },
      404,
    ),
  );
  app.onError((err, c) => {
    const e = err as Error;
    console.error('[sibergate] unhandled error:', e.message);
    pushConsoleLog('error', 'system', `unhandled error: ${e.message}`, {
      method: c.req.method, path: new URL(c.req.url).pathname, stack: e.stack?.slice(0, 500),
    });
    return c.json(
      { error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } },
      500,
    );
  });

  const cfg = configStore.get();
  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`🚪 SiberGate listening on http://${info.address}:${info.port}`);
    console.log(`   Providers: ${cfg.providers.map((p) => p.id).join(', ') || '(none)'}`);
    console.log(`   Routes: ${cfg.routes.map((r) => `${r.id} (${r.strategy})`).join(', ') || '(none)'}`);
    console.log(`   Models: ${cfg.models.length}`);
    console.log(`   Client auth: ${cfg.apiKeys.length > 0 ? 'enabled' : 'OPEN (run: npm run seed)'}`);
    console.log(`   Admin API: /admin/* (key ends …${adminKey.slice(-6)})`);
    pushConsoleLog('info', 'system', `SiberGate listening on http://${info.address}:${info.port}`, {
      port: info.port, address: info.address,
      providers: cfg.providers.map((p) => p.id),
      routes: cfg.routes.map((r) => r.id),
      models: cfg.models.length,
      clientAuth: cfg.apiKeys.length > 0 ? 'enabled' : 'open',
    });
  });

  const nodeServer = server as unknown as {
    requestTimeout: number;
    timeout: number;
    headersTimeout: number;
    keepAliveTimeout: number;
  };
  nodeServer.requestTimeout = readTimeoutMs('SIBERGATE_SERVER_REQUEST_TIMEOUT_MS', 0);
  nodeServer.timeout = readTimeoutMs('SIBERGATE_SERVER_SOCKET_TIMEOUT_MS', 0);
  nodeServer.headersTimeout = readTimeoutMs('SIBERGATE_SERVER_HEADERS_TIMEOUT_MS', 120_000);
  nodeServer.keepAliveTimeout = readTimeoutMs('SIBERGATE_SERVER_KEEPALIVE_TIMEOUT_MS', 60_000);
}

main().catch((err) => {
  console.error('[sibergate] fatal:', err);
  process.exit(1);
});
