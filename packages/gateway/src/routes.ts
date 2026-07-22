import { Hono, type Context } from 'hono';
import {
  ConfigStore,
  computeCost,
  estimateTokens,
  executeRoute,
  getRoute,
  logRequest,
  convertResponsesToChat,
  type RouteModality,
} from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { proxySSEStream, proxyResponsesSSEStream } from './stream.js';
import { errorResponse } from './errors.js';
import { isAsyncTaskResponse, buildPollUrl, pollTaskUntilDone, buildOpenAIImageResponse } from './image-task.js';

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

      // Route/target modality 'responses': upstream menerima/mengembalikan format
      // Responses API, tapi client tetap format chat/completions. Convert di gateway.
      // Pakai servedBy.modality (override per-target) bila ada; fallback route.modality.
      // Ini krusial: jika target OpenAI responses sukses setelah failover, gateway
      // harus convert — walau route.modality mungkin 'chat'.
      const isResponsesModality = (servedBy.modality ?? route.modality ?? 'chat') === 'responses';
      // Model id upstream = strip prefix provider (sama dgn yg dikirim adapter).
      const upstreamModelForLog = servedBy.modelId.startsWith(`${servedBy.providerId}/`)
        ? servedBy.modelId.slice(servedBy.providerId.length + 1)
        : servedBy.modelId;

      if (body.stream === true) {
        // Streaming: pakai SSE converter bila responses modality, verbatim lainnya.
        const { response: streamRes, done } = isResponsesModality
          ? proxyResponsesSSEStream(c, response, upstreamModelForLog)
          : proxySSEStream(c, response);
        done.then((res) => {
          const promptTokens = res.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
          const completionTokens = res.usage?.completion_tokens ?? estimateTokens(res.content);
          const totalTokens = res.usage?.total_tokens ?? promptTokens + completionTokens;
          const model = config.models.find((m) => m.id === servedBy.modelId);
          const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
          logRequest({
            ...baseLog,
            provider: servedBy.providerId,
            model: servedBy.modelId,
            latencyMs: Math.round(performance.now() - startedAt),
            promptTokens,
            completionTokens,
            totalTokens,
            costUsd,
            metadata: { trail },
          });
        });
        return streamRes;
      }

      // Non-streaming.
      if (isResponsesModality) {
        // Responses API: convert JSON → format chat/completions sebelum return.
        const responsesJson = (await response.json()) as Record<string, unknown>;
        const chatJson = convertResponsesToChat(responsesJson);
        const promptTokens = chatJson.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
        const completionTokens = chatJson.usage?.completion_tokens ?? 0;
        const totalTokens = chatJson.usage?.total_tokens ?? promptTokens + completionTokens;
        const model = config.models.find((m) => m.id === servedBy.modelId);
        const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
        logRequest({
          ...baseLog,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          metadata: { trail },
        });
        return c.json(chatJson);
      }

      // Non-streaming chat default: passthrough JSON, extract usage.
      const json = (await response.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
      const completionTokens = json.usage?.completion_tokens ?? 0;
      const totalTokens = json.usage?.total_tokens ?? promptTokens + completionTokens;
      const model = config.models.find((m) => m.id === servedBy.modelId);
      const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
      logRequest({
        ...baseLog,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
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
   *
   * Pengecualian: /v1/images/generations punya handler khusus (imageHandler) yg
   * menangani async task-based provider (mis. Kling AI). Provider tsb balas
   * data.task_id alih-alih URL gambar, lalu gateway poll sampai sukses dan
   * return format OpenAI. Provider sync (DALL-E, dll) tetap diteruskan verbatim.
   */
  app.post('/v1/images/generations', (c) => imageHandler(c, configStore));
  app.post('/v1/audio/speech', (c) => modalityHandler(c, configStore, 'speech', '/v1/audio/speech'));
  app.post('/v1/audio/transcriptions', (c) => modalityHandler(c, configStore, 'transcribe', '/v1/audio/transcriptions'));
  app.post('/v1/embeddings', (c) => modalityHandler(c, configStore, 'embed', '/v1/embeddings'));
  // SiberGate extension — text-to-music (e.g. DeepInfra ACE-Step).
  app.post('/v1/music/generations', (c) => modalityHandler(c, configStore, 'music', '/v1/music/generations'));

  // SiberGate extension — generic REST passthrough. Unlike the OpenAI-shaped
  // endpoints above, this one selects the route from the URL path, forwards
  // the original HTTP method + headers + body verbatim, and returns the upstream
  // response (status, headers, body) untouched. Lets SiberGate proxy non-LLM
  // APIs with the same routing/failover as LLM routes.
  //
  // Pakai wildcard splat (bukan :routeId) supaya route id multi-segment
  // ('app/secret', 'team/prod/chat') juga match. Ambiguitas pemisahan route id
  // vs path suffix di-resolve di genericHandler dgn longest-prefix match.
  app.all('/v1/generic/*', (c) => genericHandler(c, configStore));

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
    // Non-chat modalities don't carry token usage today, so cost stays 0 until
    // per-modality pricing (per-image/per-second) is wired. The lookup is here
    // so filling a model's price later makes it count with no code change.
    const model = config.models.find((m) => m.id === servedBy.modelId);
    const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      latencyMs,
      costUsd,
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

/**
 * Image handler khusus /v1/images/generations. Mendukung dua jenis provider:
 *
 *  1. Provider sync (DALL-E, dll): response upstream sudah berisi URL gambar
 *     dgn format OpenAI (`{created, data:[{url}]}`). Diteruskan verbatim.
 *
 *  2. Provider async/task-based (Kling AI, beberapa inference platform):
 *     response upstream berisi `{data:{task_id, task_status:'submitted'}}`.
 *     Gateway poll GET {endpoints.image}/{task_id} tiap 5 detik (max 10x)
 *     sampai task_status='succeed', lalu ambil task_result.images[].url dan
 *     return format OpenAI. Bila gagal/error, return error OpenAI-compat.
 *
 * Client tidak perlu tahu provider mana yg dipakai — gateway handle invisible.
 * Failover engine tetap berlaku saat POST pertama gagal (provider down); polling
 * hanya aktif setelah POST berhasil dan mengembalikan task_id.
 */
async function imageHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');
  const path = '/v1/images/generations';

  const parsed = await c.req.json().catch(() => null);
  if (!parsed) return errorResponse(c, 400, 'Request body must be valid JSON.', 'invalid_request_error');

  const body = parsed as Record<string, unknown>;
  const routeId = String(body.model ?? '');
  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }
  if ((route.modality ?? 'chat') !== 'image') {
    return errorResponse(
      c, 400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not an image route.`,
      'invalid_request_error', 'modality_mismatch', 'model',
    );
  }

  const controller = new AbortController();
  // Timeout lebih panjang utk image async (polling butuh waktu). Beri buffer
  // di atas max 10x5s polling = 50s.
  const timeout = setTimeout(() => controller.abort(), (route.timeoutMs ?? 300_000));
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const baseLog = {
    requestId,
    method: 'POST',
    path,
    route: route.id,
    strategy: route.strategy,
    modality: 'image' as RouteModality,
    streamed: false,
    status: 200,
    latencyMs: 0,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };

  try {
    const { response, servedBy, latencyMs } = await executeRoute(config, route, body, controller.signal);
    const upstreamContentType = response.headers.get('content-type') ?? 'application/json';
    const buf = Buffer.from(await response.arrayBuffer());

    // Cek apakah response adalah async task (perlu polling).
    let taskBody: unknown = null;
    if (upstreamContentType.includes('application/json')) {
      try {
        taskBody = JSON.parse(buf.toString('utf8'));
      } catch {
        /* bukan JSON valid — anggap sync, teruskan verbatim */
      }
    }

    if (isAsyncTaskResponse(taskBody)) {
      // Async: poll sampai sukses atau gagal.
      const provider = config.providers.find((p) => p.id === servedBy.providerId);
      if (!provider) {
        // Provider hilang di config (mis. baru di-disable). Teruskan apa adanya.
        return new Response(buf, { status: 200, headers: { 'Content-Type': upstreamContentType } });
      }
      const taskId = taskBody.data.task_id;
      const pollUrl = buildPollUrl(provider, taskId);
      const outcome = await pollTaskUntilDone(provider, pollUrl, { signal: controller.signal });
      const totalLatency = Math.round(performance.now() - startedAt);
      const model = config.models.find((m) => m.id === servedBy.modelId);
      const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);

      if (outcome.status === 'succeed') {
        const openaiResp = buildOpenAIImageResponse(outcome.images);
        logRequest({
          ...baseLog,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          latencyMs: totalLatency,
          costUsd,
        });
        return c.json(openaiResp);
      }
      // Gagal polling → return error OpenAI-compat.
      logRequest({
        ...baseLog,
        status: 502,
        latencyMs: totalLatency,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        errorCode: 'image_task_failed',
        errorMessage: outcome.message?.slice(0, 300),
        costUsd,
      });
      return errorResponse(
        c, 502,
        `Image task failed: ${outcome.message}`,
        'upstream_error',
        'image_task_failed',
        'image_generation',
      );
    }

    // Sync: teruskan verbatim (sama dgn modalityHandler default).
    const model = config.models.find((m) => m.id === servedBy.modelId);
    const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      latencyMs,
      costUsd,
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
      errorMessage: e.message?.slice(0, 300),
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null, 'image_generation');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Hop-by-hop / connection-control headers that must NOT be copied between
 * client↔upstream — they are per-connection and copying them corrupts the
 * proxy behavior. Per RFC 7230 §6.1.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  // content-encoding MUST be stripped: Node's fetch() auto-decompresses the
  // upstream body (gzip/br/deflate), so response.arrayBuffer() returns plain
  // bytes. If we forward the original "content-encoding: gzip" header with the
  // already-decompressed body, the client tries to gunzip plain JSON and fails
  // with "incorrect header check" / Z_DATA_ERROR. Drop the header so the bytes
  // are treated as-is.
  'content-encoding',
]);

/**
 * Generic REST passthrough handler (modality: 'generic').
 *
 * Unlike modalityHandler (which is OpenAI-shaped — POST JSON, route id in the
 * `model` body field, 200-on-success), this:
 *   - selects the route from the URL path param `:routeId` (no body field);
 *   - accepts ANY method (GET/POST/PUT/PATCH/DELETE) and forwards it upstream;
 *   - forwards the request body verbatim regardless of Content-Type (JSON,
 *     form, multipart, octet-stream, or empty for GET);
 *   - carries the request path suffix + query string to the upstream via the
 *     `{path}` template placeholder (for providers whose `endpoints.generic`
 *     template uses it); and
 *   - returns the upstream response with its ORIGINAL status, headers, and body
 *     intact (binary-safe), instead of hardcoding 200 + Content-Type only.
 *
 * The actual upstream call + routing + failover is handled by executeRoute →
 * the generic adapter, exactly like every other modality.
 */
async function genericHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');

  // URL matcher wildcard: /v1/generic/* → c.req.path berisi sisa path setelah
  // prefix. Karena route id sekarang boleh multi-segment ('app/secret'), kita
  // tdk bisa sekadar ambil segmen pertama. Resolve dgn longest-prefix match:
  // cari route id terpanjang yg match awal dari sisa path (setiap kandidat
  // harus diikuti oleh '/' atau akhir string — supaya 'app' tdk salah match
  // pd 'app/secret/foo').
  const splat = c.req.path.startsWith('/v1/generic/')
    ? decodeURIComponent(c.req.path.slice('/v1/generic/'.length))
    : '';
  const candidates = config.routes
    .filter((r) => r.enabled && (r.modality ?? 'chat') === 'generic')
    .map((r) => r.id)
    .filter((id) => splat === id || splat.startsWith(`${id}/`))
    .sort((a, b) => b.length - a.length);
  const routeId = candidates[0] ?? '';
  if (!routeId) {
    return errorResponse(c, 404, `Route '${splat}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }

  // Path suffix setelah route id (sisanya dari splat) — disuntik ke template
  // upstream via placeholder {path}.
  const suffix = splat.slice(routeId.length);

  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }
  // Guard: this endpoint only serves generic routes.
  if ((route.modality ?? 'chat') !== 'generic') {
    return errorResponse(
      c,
      400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not a generic route.`,
      'invalid_request_error',
      'modality_mismatch',
      'model',
    );
  }

  // Capture the request body bytes verbatim (works for any Content-Type and is
  // empty for GET). __method/__contentType/__path let the adapter forward the
  // original method + content-type + path suffix to the upstream.
  const contentType = c.req.header('content-type') ?? '';
  const raw = await c.req.text().catch(() => '');
  const body: Record<string, unknown> = {
    __method: c.req.method,
    __contentType: contentType,
    __path: suffix,
    __query: c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : '',
  };
  if (raw) body.__raw = raw;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route.timeoutMs ?? 60_000);
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const baseLog = {
    requestId,
    method: c.req.method,
    path: `/v1/generic/${routeId}${suffix}`,
    route: route.id,
    strategy: route.strategy,
    modality: 'generic' as RouteModality,
    streamed: false,
    status: 200,
    latencyMs: 0,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };

  try {
    const { response, servedBy, latencyMs } = await executeRoute(config, route, body, controller.signal);

    // Forward the upstream response verbatim: status, headers (minus hop-by-hop
    // and the auth the adapter added), and the raw body bytes (binary-safe).
    const respHeaders = new Headers();
    response.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders.set(k, v);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    // Generic passthrough is opaque to billing — no token usage to compute from.
    // Cost stays 0; the lookup is kept for symmetry in case pricing is added later.
    const model = config.models.find((m) => m.id === servedBy.modelId);
    const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
    logRequest({
      ...baseLog,
      status: response.status,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      latencyMs,
      costUsd,
    });
    return new Response(buf, {
      status: response.status,
      headers: respHeaders,
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
