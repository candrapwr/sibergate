import { Hono, type Context } from 'hono';
import {
  ConfigStore,
  estimateTokens,
  executeRoute,
  getRoute,
  logRequest,
  type RouteModality,
} from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { proxySSEStream } from './stream.js';
import { errorResponse } from './errors.js';

/**
 * Build the public OpenAI-compatible app.
 * Receives the ConfigStore so every handler reads the LIVE config — admin
 * mutations (hot-reload) are reflected without a restart.
 */
export function createApp(configStore: ConfigStore) {
  const app = new Hono<{ Variables: Vars }>();

  // Global middleware (must register before routes so they intercept all).
  app.use('*', requestIdMiddleware);
  app.use('*', authMiddleware());

  app.get('/', (c) => {
    const config = configStore.get();
    return c.json({
      name: 'SiberGate',
      status: 'ok',
      routes: config.routes.map((r) => r.id),
      providers: config.providers.map((p) => p.id),
    });
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Models list (OpenAI-compatible): expose routes as "models", tagged with modality.
  app.get('/v1/models', (c) => {
    const created = Math.floor(Date.now() / 1000);
    return c.json({
      object: 'list',
      data: configStore
        .get()
        .routes.filter((r) => r.enabled)
        .map((r) => ({
          id: r.id,
          object: 'model' as const,
          created,
          owned_by: 'sibergate',
          modality: r.modality ?? 'chat',
        })),
    });
  });

  // Chat completions — the main endpoint.
  app.post('/v1/chat/completions', async (c) => {
    const config = configStore.get();
    const requestId = c.get('requestId');
    const startedAt = c.get('startedAt');

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return errorResponse(c, 400, 'Request body must be valid JSON.', 'invalid_request_error');

    const routeId = String(body.model ?? '');
    let route;
    try {
      route = getRoute(config, routeId);
    } catch {
      return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), route.timeoutMs ?? 30_000);
    c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const baseLog = {
      requestId,
      method: 'POST',
      path: '/v1/chat/completions',
      route: route.id,
      strategy: route.strategy,
      streamed: body.stream === true,
      status: 200,
      latencyMs: 0,
      clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    };

    try {
      const { response, servedBy, latencyMs, trail } = await executeRoute(config, route, body, controller.signal);

      if (body.stream === true) {
        const { response: streamRes, done } = proxySSEStream(c, response);
        done.then((res) => {
          const promptTokens = res.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
          const completionTokens = res.usage?.completion_tokens ?? estimateTokens(res.content);
          const totalTokens = res.usage?.total_tokens ?? promptTokens + completionTokens;
          logRequest({
            ...baseLog,
            provider: servedBy.providerId,
            model: servedBy.modelId,
            latencyMs: Math.round(performance.now() - startedAt),
            promptTokens,
            completionTokens,
            totalTokens,
            metadata: { trail },
          });
        });
        return streamRes;
      }

      // Non-streaming: passthrough JSON, extract usage.
      const json = (await response.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
      const completionTokens = json.usage?.completion_tokens ?? 0;
      const totalTokens = json.usage?.total_tokens ?? promptTokens + completionTokens;
      logRequest({
        ...baseLog,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        metadata: { trail },
      });
      return c.json(json);
    } catch (err) {
      const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string }; trail?: import('@sibergate/core').FailoverStep[] };
      const status = e.status ?? 502;
      const latencyMs = Math.round(performance.now() - startedAt);
      logRequest({
        ...baseLog,
        status,
        latencyMs,
        provider: e.servedBy?.provider ?? null,
        model: e.servedBy?.model ?? null,
        errorCode: e.code ?? null,
        errorMessage: (e.message ?? String(e)).slice(0, 500),
        metadata: e.trail ? { trail: e.trail } : undefined,
      });
      const type =
        e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
      return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
    } finally {
      clearTimeout(timeout);
    }
  });

  /* ───────────── Multi-modality endpoints (image / speech / transcribe / embed / music) ─────────────
   * Each is OpenAI-compatible (except music, a SiberGate extension). They share
   * one generic handler: resolve the route (filtered by that modality), execute,
   * then forward the upstream response — binary (audio/image) or JSON — verbatim.
   */
  app.post('/v1/images/generations', (c) => modalityHandler(c, configStore, 'image', '/v1/images/generations'));
  app.post('/v1/audio/speech', (c) => modalityHandler(c, configStore, 'speech', '/v1/audio/speech'));
  app.post('/v1/audio/transcriptions', (c) => modalityHandler(c, configStore, 'transcribe', '/v1/audio/transcriptions'));
  app.post('/v1/embeddings', (c) => modalityHandler(c, configStore, 'embed', '/v1/embeddings'));
  // SiberGate extension — text-to-music (e.g. DeepInfra ACE-Step).
  app.post('/v1/music/generations', (c) => modalityHandler(c, configStore, 'music', '/v1/music/generations'));

  return app;
}

/**
 * Generic handler for non-chat modalities.
 *
 * - JSON-body modalities (image, embed, music): parse body, inject model=routeId.
 * - multipart-body modality (transcribe): pass raw bytes through with their
 *   Content-Type boundary (the adapter expects {__raw, __contentType}).
 *
 * The upstream response is forwarded verbatim with its Content-Type, so binary
 * audio/image responses are playable and JSON responses keep their shape.
 */
async function modalityHandler(
  c: Context,
  configStore: ConfigStore,
  modality: RouteModality,
  path: string,
) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');
  const contentType = c.req.header('content-type') ?? '';

  // Build the request body. Transcription uses multipart passthrough; others JSON.
  let body: Record<string, unknown>;
  if (modality === 'transcribe' && contentType.includes('multipart/form-data')) {
    const raw = await c.req.text();
    body = { __raw: raw, __contentType: contentType };
  } else {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed) return errorResponse(c, 400, 'Request body must be valid JSON.', 'invalid_request_error');
    body = parsed as Record<string, unknown>;
  }

  const routeId = String(body.model ?? '');
  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }
  // Guard: route modality must match the endpoint.
  if ((route.modality ?? 'chat') !== modality) {
    return errorResponse(
      c,
      400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not a ${modality} route.`,
      'invalid_request_error',
      'modality_mismatch',
      'model',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route.timeoutMs ?? 60_000);
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const baseLog = {
    requestId,
    method: 'POST',
    path,
    route: route.id,
    strategy: route.strategy,
    modality,
    streamed: false,
    status: 200,
    latencyMs: 0,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };

  try {
    const { response, servedBy, latencyMs } = await executeRoute(config, route, body, controller.signal);
    const upstreamContentType = response.headers.get('content-type') ?? 'application/json';

    // Forward the body verbatim with the upstream Content-Type (binary or JSON).
    const buf = Buffer.from(await response.arrayBuffer());
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      latencyMs,
    });
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': upstreamContentType, 'Content-Length': String(buf.length) },
    });
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string } };
    const status = e.status ?? 502;
    const latencyMs = Math.round(performance.now() - startedAt);
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: e.servedBy?.model ?? null,
      errorCode: e.code ?? null,
      errorMessage: (e.message ?? String(e)).slice(0, 500),
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
  } finally {
    clearTimeout(timeout);
  }
}
