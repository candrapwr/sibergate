import { Hono } from 'hono';
import {
  ConfigStore,
  ConflictError,
  ValidationError,
  createScript,
  deleteScript,
  executeScript,
  getScript,
  getScriptByName,
  listScripts,
  pushConsoleLog,
  updateScript,
  type CustomScript,
  type ScriptRunResult,
} from '@sibergate/core';
import { adminAuthMiddleware } from './admin-middleware.js';

/**
 * Custom Scripts HTTP surface — two routers:
 *
 *   1. PUBLIC  `/api/custom/<id>`  — anyone with a client API key (sg_live_*)
 *      can POST/GET and receive the script's stdout verbatim. This is the URL
 *      you register as a provider's baseUrl/endpoint so the script becomes a
 *      routing target, reusing the engine + failover unchanged.
 *
 *   2. ADMIN   `/admin/custom-scripts`  — CRUD + `/test` for the dashboard
 *      editor. Protected by the admin key (injected server-side by the Next.js
 *      proxy, same as all other /admin/* resources).
 *
 * Both mount at the gateway (index.ts). Auth is enforced by the existing
 * middleware: /api/custom/* flows through authMiddleware (needs sg_live_*),
 * /admin/custom-scripts/* through adminAuthMiddleware (needs admin key).
 */

/** Build the public script-execution router mounted at /api/custom. */
export function createCustomScriptPublicRouter() {
  const app = new Hono();

  // ANY method to /:name — the script decides what to do with method/path via
  // SIBERGATE_REQUEST_* env vars. We accept all common verbs so the endpoint
  // can be wired into any route modality (incl. generic passthrough).
  app.all('/:name', async (c) => {
    const name = c.req.param('name');
    const script = getScriptByName(name);
    if (!script || !script.enabled) {
      return c.json(
        { error: { message: `Custom script '${name}' not found or disabled.`, type: 'not_found_error', param: null, code: 'not_found' } },
        404,
      );
    }

    const url = new URL(c.req.url);
    const rawHeaders: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      rawHeaders[k] = v;
    });
    const rawBody = await c.req.text();

    const result = await executeScript({
      scriptSource: script.script,
      timeoutMs: script.timeoutMs,
      // Propagate client disconnect so a dropped connection kills the script.
      signal: c.req.raw.signal,
      input: {
        method: c.req.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        headers: rawHeaders,
        body: rawBody,
      },
    });

    const status = result.timedOut ? 504 : result.ok ? 200 : 502;
    pushConsoleLog(
      result.ok ? 'info' : 'warn',
      'custom-script',
      `script '${name}' ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode}${result.timedOut ? ' timeout' : ''}, ${result.durationMs}ms, ${result.stdout.length}B out)`,
      {
        script: name,
        method: c.req.method,
        path: url.pathname,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ok: result.ok,
        stderrPreview: result.stderr.slice(0, 300) || null,
      },
    );

    // stdout is the response body — forwarded verbatim (any format the author
    // chose). stderr is NOT sent to the client; it's only visible in the Test
    // UI and the gateway console-log above.
    return new Response(result.stdout, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  });

  app.onError((err, c) => {
    const e = err as Error;
    if (e instanceof ValidationError) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', param: null, code: 'invalid_id' } }, 400);
    }
    console.error('[sibergate] custom-script public error:', e.message);
    pushConsoleLog('error', 'custom-script', `public handler error: ${e.message}`, { stack: e.stack?.slice(0, 500) });
    return c.json({ error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } }, 500);
  });

  return app;
}

/** Build the admin CRUD + test router mounted at /admin/custom-scripts. */
export function createCustomScriptAdminRouter(configStore: ConfigStore) {
  const app = new Hono();
  app.use('*', adminAuthMiddleware(process.env.SIBERGATE_ADMIN_KEY!));

  const reload = () => {
    const cfg = configStore.reload();
    pushConsoleLog('info', 'config', `config reloaded after custom-script change (v${configStore.getVersion()})`, {
      version: configStore.getVersion(),
      providers: cfg.providers.length,
    });
    return cfg;
  };

  /* ───────────────────────────── List / Get ───────────────────────────── */
  app.get('/', (c) => c.json({ data: listScripts() }));

  app.get('/:id', (c) => {
    const s = getScript(c.req.param('id'));
    return s ? c.json(s) : c.json(notFound('script'), 404);
  });

  /* ─────────────────────────────── Create ─────────────────────────────── */
  app.post('/', async (c) => {
    const body = await c.req.json();
    const created = createScript(body);
    reload();
    return c.json(created, 201);
  });

  /* ─────────────────────────────── Update ─────────────────────────────── */
  app.patch('/:id', async (c) => {
    const body = await c.req.json();
    const updated = updateScript(c.req.param('id'), body);
    if (!updated) return c.json(notFound('script'), 404);
    reload();
    return c.json(updated);
  });

  /* ─────────────────────────────── Delete ─────────────────────────────── */
  app.delete('/:id', (c) => {
    const ok = deleteScript(c.req.param('id'));
    if (!ok) return c.json(notFound('script'), 404);
    reload();
    return c.json({ ok: true });
  });

  /* ─────────────────────── Test execution (editor) ────────────────────── */
  // Body: { input: string } — the raw request body to feed stdin. Optional.
  app.post('/:id/test', async (c) => {
    const s = getScript(c.req.param('id'));
    if (!s) return c.json(notFound('script'), 404);
    const body = (await c.req.json().catch(() => ({}))) as { input?: string; method?: string; path?: string; query?: string };
    const result: ScriptRunResult = await executeScript({
      scriptSource: s.script,
      timeoutMs: s.timeoutMs,
      input: {
        method: body.method ?? 'POST',
        path: body.path ?? '/api/custom/' + s.id,
        query: body.query ?? '',
        headers: {},
        body: body.input ?? '',
      },
    });
    pushConsoleLog('info', 'custom-script', `test run '${s.id}' (exit ${result.exitCode}, ${result.durationMs}ms)`, {
      script: s.id, test: true, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
    });
    return c.json(result);
  });

  /* ─────────────────── Run ad-hoc source (preview before save) ────────── */
  // Body: { script: string, input?: string, timeoutMs?: number }
  app.post('/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { script?: string; input?: string; timeoutMs?: number };
    if (!body.script) {
      return c.json({ error: { message: 'script source is required', type: 'invalid_request_error', param: 'script', code: 'missing' } }, 400);
    }
    const result = await executeScript({
      scriptSource: body.script,
      timeoutMs: body.timeoutMs ?? 10_000,
      input: {
        method: 'POST',
        path: '/test',
        query: '',
        headers: {},
        body: body.input ?? '',
      },
    });
    return c.json(result);
  });

  app.onError((err, c) => {
    const e = err as Error;
    if (e instanceof ConflictError) {
      return c.json({ error: { message: e.message, type: 'conflict_error', param: null, code: 'in_use' } }, 409);
    }
    if (e instanceof ValidationError) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', param: null, code: 'invalid_id' } }, 400);
    }
    console.error('[sibergate] custom-script admin error:', e.message);
    return c.json({ error: { message: 'Internal server error.', type: 'internal_error', param: null, code: null } }, 500);
  });

  return app;
}

function notFound(resource: string) {
  return { error: { message: `${resource} not found`, type: 'not_found_error', param: null, code: 'not_found' } };
}

/** Unused at runtime, exported to keep type re-exports tidy for callers. */
export type { CustomScript };
