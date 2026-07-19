import { Hono } from 'hono';
import {
  admin,
  ConfigStore,
  ConflictError,
  ValidationError,
  KNOWN_PROVIDERS,
  backupToJson,
  createBackup,
  createUser,
  deleteUser,
  listUsers,
  parseBackup,
  restoreBackup,
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
    if (!body.provider) {
      return c.json({ error: 'invalid_input', message: 'Provider is required.' }, 400);
    }
    // Ambil nama model: field 'id' bisa berisi nama polos ('gpt-4o-mini') atau
    // sudah namespaced ('openai/gpt-4o-mini'). Strip prefix '{provider}/' bila
    // ada agar kita selalu punya nama murni, lalu prefik ulang secara konsisten.
    let name = typeof body.id === 'string' ? body.id.trim() : '';
    if (name.startsWith(`${body.provider}/`)) {
      name = name.slice(body.provider.length + 1);
    }
    // Tolak nama kosong — sebelumnya bug: nama kosong lolos krn `if (body.id)`
    // cek truthiness, lalu tersimpan dgn id '' (string kosong) di DB, yg tidak
    // bisa dihapus via URL /admin/models/ karena trailing slash hilang/ambigu.
    if (!name) {
      return c.json({ error: 'invalid_input', message: 'Model name must not be empty.' }, 400);
    }
    body.id = `${body.provider}/${name}`;

    // Cegah duplikat: kombinasi (provider, id) sudah ada → tolang dgn 409.
    // Tanpa cek ini, ON CONFLICT di upsertModel akan diam-diam meng-update baris
    // lama dan API balas 201 — inilah bug lama yg menimpa model provider lain.
    const dup = admin.findModel(body.provider, body.id);
    if (dup) {
      return c.json({ error: 'model_exists', message: `Model '${body.id}' already exists for provider '${body.provider}'.` }, 409);
    }
    const created = admin.upsertModel(body);
    reload();
    return c.json(created, 201);
  });

  // NOTE: model ids can contain a slash (e.g. "anthropic/claude-sonnet-4.6",
  // "meta-llama/Llama-3.3-70B"). A :id param won't match slashes, so we use a
  // wildcard splat and extract the id from the full URL pathname.
  const modelId = (c: any) => {
    const pathname = new URL(c.req.url).pathname;
    // Strip the /admin/models/ prefix (router is mounted at /admin).
    return decodeURIComponent(pathname.replace(/^\/admin\/models\//, ''));
  };

  app.get('/models/*', (c) => {
    const id = modelId(c);
    const row = admin.getModel(id);
    return row ? c.json(row) : c.json(notFound('model'), 404);
  });

  app.put('/models/*', async (c) => {
    const body = await c.req.json();
    const updated = admin.upsertModel({ ...body, id: modelId(c) });
    reload();
    return c.json(updated);
  });

  // Partial update (e.g. toggle enabled). Merge onto the FULL existing row so a
  // bare {enabled:false} preserves every other field (context window, prices,
  // capabilities, modalities) — previously those were wiped to null.
  app.patch('/models/*', async (c) => {
    const id = modelId(c);
    const existing = admin.getModel(id) as Record<string, unknown> | null;
    if (!existing) return c.json(notFound('model'), 404);
    const body = await c.req.json();
    // Start from ALL existing fields, then apply the patch on top.
    const merged = { ...existing, ...body, id };
    const updated = admin.upsertModel(merged);
    reload();
    return c.json(updated);
  });

  app.delete('/models/*', (c) => {
    const ok = admin.deleteModel(modelId(c));
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

  // NOTE: route ids can contain a slash (e.g. "/xxxx", "v1/smart",
  // "org/route-name"). A :id param won't match slashes, so we use a wildcard
  // splat and extract the id from the full URL pathname — same fix that was
  // applied to /models for ids like "anthropic/claude-sonnet-4.6".
  const routeId = (c: any) => {
    const pathname = new URL(c.req.url).pathname;
    // Strip the /admin/routes/ prefix (router is mounted at /admin).
    return decodeURIComponent(pathname.replace(/^\/admin\/routes\//, ''));
  };

  app.get('/routes/*', (c) => {
    const row = admin.getRouteRow(routeId(c));
    return row ? c.json(row) : c.json(notFound('route'), 404);
  });

  app.put('/routes/*', async (c) => {
    const body = await c.req.json();
    const updated = admin.upsertRoute({ ...body, id: routeId(c) });
    reload();
    return c.json(updated);
  });

  // Partial update (e.g. toggle enabled). Merge onto the FULL existing row so a
  // bare {enabled:false} preserves modality, timeout, retryOn, targets, etc.
  app.patch('/routes/*', async (c) => {
    const id = routeId(c);
    const existing = admin.getRouteRow(id) as Record<string, unknown> | null;
    if (!existing) return c.json(notFound('route'), 404);
    const body = await c.req.json();
    const merged = { ...existing, ...body, id };
    const updated = admin.upsertRoute(merged);
    reload();
    return c.json(updated);
  });

  app.delete('/routes/*', (c) => {
    const ok = admin.deleteRoute(routeId(c));
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

  // Rotate the secret of an existing key (same id/name, new secret). Returns the
  // new plaintext ONCE, like POST /api-keys. The old secret 401s immediately.
  app.post('/api-keys/:id/regenerate', (c) => {
    const result = admin.regenerateApiKey(c.req.param('id'));
    if (!result) return c.json(notFound('api_key'), 404);
    reload();
    return c.json({ ...result.apiKey, plaintext: result.plaintext }, 201);
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

  // Hanya hapus request log (tabel requests). Master data aman.
  app.post('/logs/clear', (c) => {
    const removed = admin.clearLogs();
    return c.json({ ok: true, removed });
  });

  // Reset stats = clear logs + reset latency EMA in-memory. Karena usage di
  // SiberGate dihitung dari requests, ini mengosongkan semua stat agregat.
  app.post('/stats/reset', (c) => {
    const removed = admin.resetStats();
    return c.json({ ok: true, removed });
  });

  /* ─────────────────────────── /admin/backup & restore ─────────────────── */
  // Download a full backup (DB + master key) as a JSON file.
  app.get('/backup', (c) => {
    try {
      const payload = createBackup();
      const json = backupToJson(payload);
      const filename = `sibergate-backup-${new Date().toISOString().slice(0, 10)}.json`;
      c.header('Content-Type', 'application/json');
      c.header('Content-Disposition', `attachment; filename="${filename}"`);
      return c.body(json);
    } catch (err) {
      return c.json({ error: { message: (err as Error).message, type: 'backup_error' } }, 500);
    }
  });

  // Restore from an uploaded backup JSON. Overwrites DB + master key.
  // The process should be restarted after restore.
  app.post('/restore', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { confirm?: string; db?: string; masterKey?: string };
    if (!body) return c.json({ error: { message: 'Invalid backup payload.', type: 'invalid_request_error' } }, 400);
    try {
      restoreBackup(parseBackup(JSON.stringify(body)));
      // restoreBackup closed + re-opened the DB; reload the cached config from
      // the restored file so the change applies immediately (no restart needed).
      reload();
      return c.json({ ok: true, message: 'Restore complete — config reloaded.' });
    } catch (err) {
      return c.json({ error: { message: (err as Error).message, type: 'restore_error' } }, 500);
    }
  });

  // Map domain errors to clean HTTP responses.
  app.onError((err, c) => {
    if (err instanceof ConflictError) {
      return c.json(
        { error: { message: err.message, type: 'conflict_error', param: null, code: 'in_use' } },
        409,
      );
    }
    if (err instanceof ValidationError) {
      return c.json(
        { error: { message: err.message, type: 'invalid_request_error', param: null, code: 'invalid_id' } },
        400,
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
