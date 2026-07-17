import { serve } from '@hono/node-server';
import { ConfigStore, getDb, loadDotEnv } from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { createApp } from './routes.js';
import { createAdminRouter } from './admin-routes.js';
import { getOrCreateAdminKey } from './admin-middleware.js';

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
    return c.json(
      { error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } },
      500,
    );
  });

  const cfg = configStore.get();
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`🚪 SiberGate listening on http://${info.address}:${info.port}`);
    console.log(`   Providers: ${cfg.providers.map((p) => p.id).join(', ') || '(none)'}`);
    console.log(`   Routes: ${cfg.routes.map((r) => `${r.id} (${r.strategy})`).join(', ') || '(none)'}`);
    console.log(`   Models: ${cfg.models.length}`);
    console.log(`   Client auth: ${cfg.apiKeys.length > 0 ? 'enabled' : 'OPEN (run: npm run seed)'}`);
    console.log(`   Admin API: /admin/* (key ends …${adminKey.slice(-6)})`);
  });
}

main().catch((err) => {
  console.error('[sibergate] fatal:', err);
  process.exit(1);
});
