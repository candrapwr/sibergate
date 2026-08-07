import { Hono } from 'hono';
import {
  ConfigStore,
  ConflictError,
  ValidationError,
  createProxyPool,
  updateProxyPool,
  getProxyPool,
  listProxyPools,
  deleteProxyPool,
  listPoolMembers,
  addPoolMember,
  updatePoolMember,
  deletePoolMember,
  listPoolBindings,
  bindProviderToPool,
  unbindProviderFromPool,
  testProxy,
  updateMemberHealth,
  recentProxyLogs,
  clearProxyLogs,
  downloadGeoIpDb,
  geoipStatus,
  pushConsoleLog,
  type ProxyPool,
  type ProxyPoolMember,
} from '@sibergate/core';
import { adminAuthMiddleware } from './admin-middleware.js';

/**
 * Proxy Layer admin router — mounted at /admin/proxy.
 *
 * CRUD proxy pools + members + provider bindings, plus:
 *   - POST /pools/:id/members/:memberId/test  → connectivity + latency + geoip flag
 *   - GET  /logs                              → recent proxy event log
 *   - POST /geoip/update                      → download GeoLite2 mmdb on-demand
 *   - GET  /geoip/status                      → mmdb file status (size, mtime, errors)
 */
export function createProxyAdminRouter(configStore: ConfigStore) {
  const app = new Hono();
  app.use('*', adminAuthMiddleware(process.env.SIBERGATE_ADMIN_KEY!));

  const reload = () => {
    const cfg = configStore.reload();
    pushConsoleLog('info', 'config', `config reloaded after proxy change (v${configStore.getVersion()})`, {
      version: configStore.getVersion(),
      providers: cfg.providers.length,
    });
    return cfg;
  };

  function notFound(resource: string) {
    return { error: { message: `${resource} not found`, type: 'not_found_error', param: null, code: 'not_found' } };
  }

  /* ─────────────────────────── Pools ──────────────────────────── */
  app.get('/pools', (c) => c.json({ data: listProxyPools() }));

  app.post('/pools', async (c) => {
    const body = await c.req.json();
    const created = createProxyPool(body);
    reload();
    return c.json(created, 201);
  });

  app.get('/pools/:id', (c) => {
    const pool = getProxyPool(c.req.param('id'));
    return pool ? c.json(pool) : c.json(notFound('pool'), 404);
  });

  app.patch('/pools/:id', async (c) => {
    const body = await c.req.json();
    const updated = updateProxyPool(c.req.param('id'), body);
    if (!updated) return c.json(notFound('pool'), 404);
    reload();
    return c.json(updated);
  });

  app.delete('/pools/:id', (c) => {
    const ok = deleteProxyPool(c.req.param('id'));
    if (!ok) return c.json(notFound('pool'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ────────────────────────── Members ─────────────────────────── */
  app.get('/pools/:id/members', (c) => {
    if (!getProxyPool(c.req.param('id'))) return c.json(notFound('pool'), 404);
    return c.json({ data: listPoolMembers(c.req.param('id')) });
  });

  app.post('/pools/:id/members', async (c) => {
    const body = await c.req.json();
    const created = addPoolMember(c.req.param('id'), body);
    reload();
    return c.json(created, 201);
  });

  app.patch('/pools/:id/members/:memberId', async (c) => {
    const body = await c.req.json();
    const updated = updatePoolMember(Number(c.req.param('memberId')), body);
    if (!updated) return c.json(notFound('member'), 404);
    reload();
    return c.json(updated);
  });

  app.delete('/pools/:id/members/:memberId', (c) => {
    const ok = deletePoolMember(Number(c.req.param('memberId')));
    if (!ok) return c.json(notFound('member'), 404);
    reload();
    return c.json({ ok: true });
  });

  // Test satu member → connectivity + latency + exit IP + geoip flag.
  app.post('/pools/:id/members/:memberId/test', async (c) => {
    const memberId = Number(c.req.param('memberId'));
    // Ambil member utk dapat proxyUrl (bisa juga test ad-hoc via body).
    const members = listPoolMembers(c.req.param('id'));
    const member = members.find((m) => m.id === memberId);
    if (!member) return c.json(notFound('member'), 404);
    const result = await testProxy(member.proxyUrl);
    // Cache hasil ke DB (health + geoip).
    updateMemberHealth(memberId, result);
    reload();
    return c.json(result);
  });

  /* ─────────────────────── Provider bindings ──────────────────── */
  app.get('/pools/:id/bindings', (c) => {
    if (!getProxyPool(c.req.param('id'))) return c.json(notFound('pool'), 404);
    return c.json({ data: listPoolBindings(c.req.param('id')) });
  });

  app.post('/pools/:id/bindings', async (c) => {
    const body = await c.req.json();
    bindProviderToPool(body.providerId, c.req.param('id'), body.enabled !== false);
    reload();
    return c.json({ ok: true });
  });

  app.delete('/pools/:id/bindings/:providerId', (c) => {
    unbindProviderFromPool(c.req.param('providerId'), c.req.param('id'));
    reload();
    return c.json({ ok: true });
  });

  /* ─────────────────────────── Logs ───────────────────────────── */
  app.get('/logs', (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json({ data: recentProxyLogs(Math.min(Math.max(limit, 1), 500)) });
  });

  app.delete('/logs', (c) => {
    clearProxyLogs();
    return c.json({ ok: true });
  });

  /* ─────────────────────────── GeoIP ──────────────────────────── */
  app.get('/geoip/status', (c) => c.json(geoipStatus()));

  app.post('/geoip/update', async (c) => {
    const result = await downloadGeoIpDb();
    pushConsoleLog(result.ok ? 'success' : 'error', 'proxy', `GeoIP DB ${result.ok ? 'updated' : 'update failed'}`, { ...result });
    return c.json(result, result.ok ? 200 : 400);
  });

  /* ────────────────────────── onError ─────────────────────────── */
  app.onError((err, c) => {
    const e = err as Error;
    if (e instanceof ConflictError) {
      return c.json({ error: { message: e.message, type: 'conflict_error', param: null, code: 'in_use' } }, 409);
    }
    if (e instanceof ValidationError) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', param: null, code: 'invalid_input' } }, 400);
    }
    console.error('[sibergate] proxy admin error:', e.message);
    return c.json({ error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } }, 500);
  });

  return app;
}
