import { Hono } from 'hono';
import {
  admin,
  ConfigStore,
  ConflictError,
  KNOWN_PROVIDERS,
  createUser,
  deleteUser,
  listUsers,
  setUserStatus,
  updateUser,
  type SiberGateConfig,
} from '@sibergate/core';
import { adminAuthMiddleware } from './admin-middleware.js';

/**
 * Admin REST API — mounted at /admin/* with its own auth (SIBERGATE_ADMIN_KEY).
 *
 * Full CRUD over master data. Every successful mutation calls
 * `configStore.reload()` so changes apply immediately (hot-reload, no restart).
 *
 * Resource shape note: provider/model/route "id" is the URL-safe primary key.
 * On create, body must include id (+ required fields). On update, PATCH merges.
 */
export function createAdminRouter(configStore: ConfigStore) {
  const app = new Hono();

  // All admin routes require the admin key.
  app.use('*', adminAuthMiddleware(process.env.SIBERGATE_ADMIN_KEY!));

  // Reload after a mutation so the public app sees the change immediately.
  const reload = () => configStore.reload();

  /* ─────────────────────────── /admin/system ─────────────────────────── */
  app.get('/system', (c) => {
    const cfg = configStore.get();
    return c.json({
      configVersion: configStore.getVersion(),
      providers: cfg.providers.length,
      models: cfg.models.length,
      routes: cfg.routes.length,
      apiKeys: cfg.apiKeys.length,
    });
  });

  // Force reload (e.g. after external DB edits).
  app.post('/reload', (c) => {
    const cfg = reload();
    return c.json({ ok: true, version: configStore.getVersion(), routes: cfg.routes.map((r) => r.id) });
  });

  /* ─────────────────────────── /admin/providers ──────────────────────── */
  app.get('/providers', (c) => c.json({ data: admin.listProviders() }));

  app.post('/providers', async (c) => {
    const body = await c.req.json();
    const created = admin.createProvider(body);
    reload();
    return c.json(created, 201);
  });

  app.get('/providers/:id', (c) => {
    const row = admin.getProvider(c.req.param('id'));
    return row ? c.json(row) : c.json(notFound('provider'), 404);
  });

  app.patch('/providers/:id', async (c) => {
    const body = await c.req.json();
    const updated = admin.updateProvider(c.req.param('id'), body);
    if (!updated) return c.json(notFound('provider'), 404);
    reload();
    return c.json(updated);
  });

  app.delete('/providers/:id', (c) => {
    const ok = admin.deleteProvider(c.req.param('id'));
    if (!ok) return c.json(notFound('provider'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ───────────────────────────── /admin/models ───────────────────────── */
  app.get('/models', (c) => c.json({ data: admin.listModels() }));

  app.post('/models', async (c) => {
    const body = await c.req.json();
    const created = admin.upsertModel(body);
    reload();
    return c.json(created, 201);
  });

  app.get('/models/:id', (c) => {
    const row = admin.getModel(c.req.param('id'));
    return row ? c.json(row) : c.json(notFound('model'), 404);
  });

  app.put('/models/:id', async (c) => {
    const body = await c.req.json();
    const updated = admin.upsertModel({ ...body, id: c.req.param('id') });
    reload();
    return c.json(updated);
  });

  // Partial update (e.g. toggle enabled). Merge onto the existing row so a
  // bare {enabled:false} works without re-supplying required fields.
  app.patch('/models/:id', async (c) => {
    const id = c.req.param('id');
    const existing = admin.getModel(id) as Record<string, unknown> | null;
    if (!existing) return c.json(notFound('model'), 404);
    const body = await c.req.json();
    const merged = {
      id,
      provider: existing.provider,
      displayName: existing.displayName,
      modalities: existing.modalities,
      ...body,
    };
    const updated = admin.upsertModel(merged);
    reload();
    return c.json(updated);
  });

  app.delete('/models/:id', (c) => {
    const ok = admin.deleteModel(c.req.param('id'));
    if (!ok) return c.json(notFound('model'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ───────────────────────────── /admin/routes ───────────────────────── */
  app.get('/routes', (c) => c.json({ data: admin.listRoutes() }));

  app.post('/routes', async (c) => {
    const body = await c.req.json();
    const created = admin.upsertRoute(body);
    reload();
    return c.json(created, 201);
  });

  app.get('/routes/:id', (c) => {
    const row = admin.getRouteRow(c.req.param('id'));
    return row ? c.json(row) : c.json(notFound('route'), 404);
  });

  app.put('/routes/:id', async (c) => {
    const body = await c.req.json();
    const updated = admin.upsertRoute({ ...body, id: c.req.param('id') });
    reload();
    return c.json(updated);
  });

  // Partial update (e.g. toggle enabled). Merge onto the existing row so a
  // bare {enabled:false} works without re-supplying targets/required fields.
  app.patch('/routes/:id', async (c) => {
    const id = c.req.param('id');
    const existing = admin.getRouteRow(id) as Record<string, unknown> | null;
    if (!existing) return c.json(notFound('route'), 404);
    const body = await c.req.json();
    const merged = {
      id,
      strategy: existing.strategy,
      ...body,
    };
    const updated = admin.upsertRoute(merged);
    reload();
    return c.json(updated);
  });

  app.delete('/routes/:id', (c) => {
    const ok = admin.deleteRoute(c.req.param('id'));
    if (!ok) return c.json(notFound('route'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ──────────────────────────── /admin/api-keys ──────────────────────── */
  app.get('/api-keys', (c) => c.json({ data: admin.listApiKeys() }));

  app.post('/api-keys', async (c) => {
    const { name } = await c.req.json();
    if (!name) return c.json({ error: { message: 'name is required', type: 'invalid_request_error', param: 'name', code: null } }, 400);
    const { apiKey, plaintext } = admin.createApiKey(name);
    reload();
    // Return plaintext ONCE alongside the stored record.
    return c.json({ ...apiKey, plaintext }, 201);
  });

  app.delete('/api-keys/:id', (c) => {
    const ok = admin.deleteApiKey(c.req.param('id'));
    if (!ok) return c.json(notFound('api_key'), 404);
    reload();
    return c.json({ ok: true });
  });

  app.patch('/api-keys/:id', async (c) => {
    const { enabled } = await c.req.json();
    const ok = admin.toggleApiKey(c.req.param('id'), enabled);
    if (!ok) return c.json(notFound('api_key'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ─────────────────────────── /admin/logs & stats ───────────────────── */
  app.get('/logs', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
    return c.json({ data: admin.recentRequests(limit) });
  });

  app.get('/stats', (c) => c.json(admin.usageStats()));

  // Detailed usage matrix: tokens + cost grouped by provider × model.
  app.get('/usage', (c) => c.json({ data: admin.usageMatrix() }));

  /* ─────────────────────────────── /admin/users ─────────────────────────── */
  app.get('/users', (c) => c.json({ data: listUsers() }));

  app.post('/users', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      name?: string;
      password?: string;
      role?: string;
    };
    if (!body.email || !body.password) {
      return c.json({ error: { message: 'email and password are required.', type: 'invalid_request_error', param: null, code: null } }, 400);
    }
    try {
      const user = createUser({ email: body.email, name: body.name ?? body.email, password: body.password, role: body.role ?? 'admin' });
      reload();
      return c.json(user, 201);
    } catch {
      return c.json({ error: { message: 'A user with that email already exists.', type: 'conflict_error', param: 'email', code: 'duplicate' } }, 409);
    }
  });

  app.patch('/users/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      role?: string;
      password?: string;
      status?: 'active' | 'disabled';
    };
    if (body.status) {
      setUserStatus(id, body.status);
    }
    if (body.name || body.role || body.password) {
      updateUser(id, { name: body.name, role: body.role, password: body.password });
    }
    reload();
    return c.json({ ok: true });
  });

  app.delete('/users/:id', (c) => {
    const ok = deleteUser(c.req.param('id'));
    if (!ok) return c.json(notFound('user'), 404);
    reload();
    return c.json({ ok: true });
  });

  // Map domain errors to clean HTTP responses.

  /* ─────────────────────────── /admin/bulk operations ─────────────────── */
  app.post('/import-providers', (c) => {
    const result = admin.importKnownProviders(KNOWN_PROVIDERS);
    reload();
    return c.json({ ok: true, ...result });
  });

  app.post('/reset', async (c) => {
    // Require an explicit confirm token in the body to avoid accidental wipes.
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'DELETE_EVERYTHING') {
      return c.json(
        { error: { message: 'Missing confirm: "DELETE_EVERYTHING".', type: 'invalid_request_error', param: 'confirm', code: 'confirmation_required' } },
        400,
      );
    }
    const removed = admin.clearAllData();
    reload();
    return c.json({ ok: true, removed });
  });

  // Map domain errors to clean HTTP responses.
  app.onError((err, c) => {
    if (err instanceof ConflictError) {
      return c.json(
        { error: { message: err.message, type: 'conflict_error', param: null, code: 'in_use' } },
        409,
      );
    }
    console.error('[sibergate] admin error:', (err as Error).message);
    return c.json(
      { error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } },
      500,
    );
  });

  return app;
}

function notFound(resource: string) {
  return {
    error: {
      message: `${resource} not found`,
      type: 'not_found_error',
      param: null,
      code: 'not_found',
    },
  };
}
