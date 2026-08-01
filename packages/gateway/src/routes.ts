import { Hono, type Context } from 'hono';
import {
  ConfigStore,
  computeCost,
  estimateTokens,
  executeRoute,
  getRoute,
  logRequest,
  pushConsoleLog,
  convertResponsesToChat,
  convertChatRequestToToolsText,
  convertToolsTextToChat,
  storeSignature,
  getSignature,
  getDefaultSignature,
  storeReasoning,
  getReasoning,
  reasoningKeyFor,
  saveRequestTrace,
  type RequestTraceData,
  type RouteModality,
} from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { proxySSEStream, proxyResponsesSSEStream, proxyToolsTextSSEStream } from './stream.js';
import { errorResponse, mapUpstreamErrorStatus } from './errors.js';
import { isAsyncTaskResponse, buildPollUrl, pollTaskUntilDone, buildOpenAIImageResponse } from './image-task.js';

/**
 * Build audit-log metadata for an upstream failure, merging the failover trail
 * with the failing upstream diagnostics (URL/status/body) when present.
 */
function errorMetadata(
  e: Error & { trail?: import('@sibergate/core').FailoverStep[]; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } },
): Record<string, unknown> | undefined {
  const trail = e.trail;
  const up = e.upstream;
  if (!trail && !up) return undefined;
  const meta: Record<string, unknown> = {};
  if (trail) meta.trail = trail;
  if (up) meta.upstream = up;
  return meta;
}

/* ─── Raw request trace (disk) ────────────────────────────────────────────
 * Saat upstream error (termasuk failover-recovered), simpan raw request lengkap
 * ke file per-request (request_traces/<id>.json). DB tetap ramping — file hanya
 * dibuat saat error & dihapus saat clear logs. Diakses via link "View raw" di
 * drawer Logs. Secrets (Authorization/api_key) di-redact sebelum ditulis.
 */

/** Header names whose values must be redacted from trace files. */
const REDACT_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-auth-token',
]);

/** Copy a Headers object into a plain record, redacting secret values. */
function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (REDACT_HEADERS.has(lk)) {
      // Keep a hint of the scheme (Bearer ***) without leaking the secret.
      const scheme = value.split(' ')[0];
      out[key] = scheme && scheme !== value ? `${scheme} ***` : '***';
    } else {
      out[key] = value;
    }
  });
  return out;
}

/**
 * Persist a raw request trace when there was an upstream error — either a
 * terminal failure OR a failover that recovered (trail contains a failed step).
 * Returns true when a trace file was written (so callers can flag metadata).
 * Fire-and-forget internally; never throws.
 */
function maybeSaveRequestTrace(opts: {
  requestId: string;
  c: Context;
  body: unknown;
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  upstreamUrl?: string;
  upstreamStatus?: number;
  upstreamBody?: string | null;
  /** The request body actually sent to the upstream (model name already the real
   *  one, not the route id). Captured directly from the adapter/error, not
   *  reconstructed. */
  upstreamRequestBody?: string | null;
  /** Headers actually sent to the upstream (already redacted by provider). */
  upstreamRequestHeaders?: Record<string, string> | null;
  hadFailover: boolean;
}): boolean {
  // Only capture when there was an actual upstream error (final failure or a
  // recovered failover). Success requests are not traced (disk hygiene).
  const upstreamPresent = opts.upstreamUrl || opts.upstreamStatus != null;
  if (!opts.hadFailover && !upstreamPresent) return false;
  try {
    const data: RequestTraceData = {
      requestId: opts.requestId,
      ts: new Date().toISOString(),
      client: {
        method: opts.c.req.method,
        path: opts.c.req.path,
        query: opts.c.req.url.includes('?') ? opts.c.req.url.slice(opts.c.req.url.indexOf('?')) : '',
        ip: opts.c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        // Prefer headers actually sent to the upstream (real Authorization of
        // the provider, not the client's sg_live_* key). Fall back to client
        // headers when upstream headers aren't available (timeout/network).
        headers: opts.upstreamRequestHeaders ?? redactHeaders(opts.c.req.raw.headers),
      },
      // Prefer the real upstream body (captured directly from the adapter/error).
      // Fall back to the raw client body if the upstream body isn't available
      // (e.g. timeout/network errors where no request body was attached).
      body: opts.upstreamRequestBody ?? opts.body,
      upstream: upstreamPresent
        ? { url: opts.upstreamUrl, status: opts.upstreamStatus, responseBody: opts.upstreamBody }
        : undefined,
      route: opts.route ?? null,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
    };
    saveRequestTrace(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a trace on the SUCCESS path when the request recovered via failover
 * (trail has ≥1 failed step). This is the case the catch-block can't cover:
 * the request ultimately succeeded (200), so it never enters the error path,
 * but an upstream target still failed — operators need that error captured.
 *
 * Extracts the failing step's upstream diagnostics from the trail so the trace
 * shows WHY failover happened, not just THAT it happened. The failing target's
 * request body + model are taken from the trail step (already the real values
 * the LLM received).
 */
function traceOnSuccess(opts: {
  requestId: string;
  c: Context;
  route?: string | null;
  trail: import('@sibergate/core').FailoverStep[];
  servedBy: import('@sibergate/core').RouteTarget;
}): boolean {
  const failedStep = opts.trail.find((s) => s.outcome === 'failed');
  if (!failedStep) return false; // no failover — nothing to trace
  return maybeSaveRequestTrace({
    requestId: opts.requestId,
    c: opts.c,
    body: undefined,
    route: opts.route ?? null,
    provider: opts.servedBy.providerId,
    model: opts.servedBy.modelId,
    // The failing target's diagnostics live in the trail step (captured by
    // engine.ts), not on the success-path error (there is none).
    upstreamRequestBody: failedStep.requestBody,
    upstreamRequestHeaders: failedStep.requestHeaders,
    upstreamBody: failedStep.upstreamBody,
    upstreamStatus: failedStep.status,
    hadFailover: true,
  });
}

/* ─── Gemini thought_signature preservation ───────────────────────────────
 * Gemini 3.x menyertakan `extra_content.google.thought_signature` di setiap
 * tool_call (response) & WAJIB dikirim balik di multi-turn. Gateway CAPTURE dari
 * response, STRIP supaya client dapat format OpenAI murni, INJECT balik saat
 * request multi-turn datang. Deteksi by field presence (cover Gemini-via-OR).
 */

type ToolCall = {
  id?: string;
  extra_content?: { google?: { thought_signature?: string } } & Record<string, unknown>;
  [k: string]: unknown;
};

/** Extract thought_signature dari sebuah tool_call. Return null bila tidak ada. */
function extractSignature(tc: ToolCall | undefined): string | null {
  const sig = tc?.extra_content?.google?.thought_signature;
  return typeof sig === 'string' && sig ? sig : null;
}

/** Strip extra_content dari sebuah tool_call (in-place). Aman bila tidak ada. */
function stripSignature(tc: ToolCall | undefined): void {
  if (tc?.extra_content) delete tc.extra_content;
}

/**
 * Inject thought_signature balik ke body.messages utk multi-turn. Walk setiap
 * assistant message dgn tool_calls, lookup signature by tool_call.id di cache,
 * set extra_content bila ada. Body pass-by-reference sampai adapter → sampai
 * upstream. No-op utk provider non-Gemini (cache kosong utk id mereka).
 *
 * HYBRID anti-restart: bila lookup by-id MISS (cache hilang krn server restart
 * atau sesi lama), fallback ke signature DEFAULT provider Gemini (signature
 * valid pertama yg pernah di-capture utk provider tsb). Lebih baik inject
 * default drpd kosong — Google saat ini menerima signature non-valid, dan
 * signature default (dari provider yg sama) lebih mungkin diterima drpd kosong.
 * Hanya berlaku bila target akhirnya provider Gemini (dideteksi saat servedBy
 * sudah diketahui di handler — di sini kita inject untuk SEMUA provider krn
 * cache hanya berisi signature Gemini; provider lain no-op).
 */
function injectSignaturesIntoMessages(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    const msg = m as { role?: string; tool_calls?: ToolCall[] };
    if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (!tc?.id) continue;
      // 1) Signature ASLI by-id (fidelity tinggi).
      let sig = getSignature(tc.id);
      // 2) Fallback: default provider Gemini (anti-restart). Coba provider Gemini
      //    yg umum dulu; getDefaultSignature return null bila provider belum pernah
      //    lihat signature (fresh start total → no-op, biarkan apa adanya).
      if (!sig) sig = getDefaultSignature('gemini') ?? getDefaultSignature('openrouter');
      if (sig) {
        // Pertahankan extra_content lain bila ada; set path google.thought_signature.
        tc.extra_content = { ...(tc.extra_content ?? {}), google: { thought_signature: sig } };
      }
    }
  }
}

/* ─── DeepSeek reasoning_content preservation ──────────────────────────────
 * Analog dgn Gemini thought_signature, tapi utk field `reasoning_content` di
 * level assistant MESSAGE (bukan tool_call). DeepSeek thinking-mode WAJIB
 * kirim balik field ini di multi-turn, jika tidak → 400.
 * Capture di response → cache by hash(content) → inject balik di request.
 * No-op utk provider non-DeepSeek (cache kosong utk mereka).
 */

/** Capture reasoning_content dari response message, strip supaya client format OpenAI murni. */
function captureAndStripReasoning(message: Record<string, unknown> | undefined | null, providerId: string): void {
  if (!message) return;
  const reasoning = message.reasoning_content;
  if (typeof reasoning === 'string' && reasoning) {
    const key = reasoningKeyFor(message.content);
    if (key) storeReasoning(key, reasoning, providerId);
  }
  // Selalu strip reasoning_content dari response ke client (field non-OpenAI).
  // Bila provider bukan thinking-mode, field ini undefined → no-op.
  if (message.reasoning_content !== undefined) delete message.reasoning_content;
}

/** Inject reasoning_content balik ke assistant messages (request multi-turn) by content hash. */
function injectReasoningIntoMessages(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== 'assistant') continue;
    const key = reasoningKeyFor(msg.content);
    if (!key) continue;
    const reasoning = getReasoning(key);
    if (reasoning) {
      (msg as { reasoning_content?: string }).reasoning_content = reasoning;
    }
  }
}

/**
 * Capture + strip signature dari sebuah tool_call list (response non-stream).
 * Simpan ke cache, hapus extra_content supaya client dapat format murni.
 */
function captureAndStripToolCalls(toolCalls: ToolCall[] | undefined, providerId: string): void {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    const sig = extractSignature(tc);
    if (sig && tc.id) {
      // Custom tools punya stable id → cache + strip, re-inject by id di turn berikutnya.
      storeSignature(tc.id, sig, providerId);
      stripSignature(tc);
    }
    // Built-in tools (web_search, pdf_script, code_execution) sering TIDAK punya
    // stable id → signature tidak bisa di-cache by id. Biarkan extra_content
    // tertinggal di response: client akan round-trip apa adanya di turn 2, jadi
    // signature tetap sampai ke Gemini tanpa perlu inject. (Sebelumnya signature
    // di-strip unconditional walau gagal di-cache → hilang → 400 multi-turn.)
  }
}

/**
 * Strip extra_content dari message level (response non-stream). Gemini menempel
 * extra_content.google.thought_signature tidak hanya di tool_calls, tapi juga di
 * top-level message (model reasoning). Field non-OpenAI → strip supaya client
 * dapat format murni. Signature di sini hanya utk tracking reasoning internal
 * Google, TIDAK wajib di-inject balik multi-turn (beda dgn signature tool_call),
 * jadi cukup hapus, tidak perlu capture.
 */
function stripMessageExtraContent(message: { extra_content?: unknown } | undefined | null): void {
  if (message?.extra_content) delete message.extra_content;
}


/**
 * Emit an "incoming" console event the moment a request enters a handler —
 * before any routing/upstream work. This anchors the start of the lifecycle:
 *   incoming (client req) → routing (route picked) → upstream (call provider)
 *   → routing (served/failed) → request (completed)
 */
function emitIncoming(c: Context, routeId: string | null, modality: string) {
  pushConsoleLog('info', 'incoming', `${c.req.method} ${c.req.path} from client`, {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    route: routeId,
    modality,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    apiKeyId: c.get('apiKeyId') ?? null,
    stream: c.req.header('accept')?.includes('text/event-stream') ?? false,
  });
}

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
    // Snapshot the pristine client body BEFORE any mutation (inject signatures/
    // reasoning mutates body.messages in place). The snapshot is used only for
    // the raw request trace when an error occurs.
    const rawClientBody = structuredClone(body);

    const routeId = String(body.model ?? '');
    let route;
    try {
      route = getRoute(config, routeId);
    } catch {
      return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
    }

    const controller = new AbortController();
    // Per-target timeout is enforced inside executeRoute (each target gets the
    // full route.timeoutMs as its own budget). This parent controller only
    // propagates a CLIENT disconnect — it must NOT abort on a route-level
    // timer, otherwise later failover targets would be cut short.
    let clientAborted = false;
    c.req.raw.signal?.addEventListener(
      'abort',
      () => {
        clientAborted = true;
        controller.abort();
      },
      { once: true },
    );

    emitIncoming(c, route.id, route.modality ?? 'chat');

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
      apiKeyId: c.get('apiKeyId') ?? null,
    };

    if (body.stream === true) {
      const encoder = new TextEncoder();
      const heartbeatMsRaw = Number(process.env.SIBERGATE_SSE_HEARTBEAT_MS ?? 10_000);
      const heartbeatMs = Number.isFinite(heartbeatMsRaw) && heartbeatMsRaw > 0 ? heartbeatMsRaw : 10_000;
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let innerLogAttached = false;

      const logStreamResult = (
        res: Awaited<ReturnType<typeof proxySSEStream>['done']>,
        servedBy: import('@sibergate/core').RouteTarget,
        trail: import('@sibergate/core').FailoverStep[],
        upstreamKeyId: string | null,
      ) => {
        const streamStatus = res.status;
        const status = streamStatus === 'client_aborted' ? 499 : streamStatus === 'upstream_error' ? 502 : 200;
        const errorCode =
          streamStatus === 'client_aborted'
            ? 'client_closed_request'
            : streamStatus === 'upstream_error'
              ? 'stream_error'
              : null;
        const errorMessage =
          streamStatus === 'client_aborted'
            ? res.errorMessage ?? 'Client disconnected before the stream completed.'
            : streamStatus === 'upstream_error'
              ? res.errorMessage ?? 'Upstream stream error.'
              : null;
        const promptTokens = res.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
        const completionTokens = res.usage?.completion_tokens ?? estimateTokens(res.content);
        const totalTokens = res.usage?.total_tokens ?? promptTokens + completionTokens;
        // DeepSeek streaming reasoning_content: capture by content-hash agar bisa
        // di-inject balik di request multi-turn berikutnya. (Non-stream di-capture
        // di captureAndStripReasoning; streaming di sini krn content baru lengkap.)
        if (res.reasoning) {
          const rKey = reasoningKeyFor(res.content);
          if (rKey) storeReasoning(rKey, res.reasoning, servedBy.providerId);
        }
        const model = config.models.find((m) => m.id === servedBy.modelId);
        const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
        // Capture a trace on the success path too when this stream recovered via
        // failover — the catch-block won't fire for a 200, but operators still
        // need to see why a target failed before this one served the request.
        const successTraced = streamStatus === 'completed'
          ? traceOnSuccess({ requestId, c, route: route.id, trail, servedBy })
          : false;
        logRequest({
          ...baseLog,
          status,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          upstreamKeyId,
          latencyMs: Math.round(performance.now() - startedAt),
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          errorCode,
          errorMessage,
          metadata: {
            trail, streamStatus,
            ...(res.errorMessage ? { streamError: res.errorMessage } : {}),
            ...(successTraced ? { hasTrace: true } : {}),
          },
        });
      };

      const logStreamFailure = (err: unknown) => {
        const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; trail?: import('@sibergate/core').FailoverStep[]; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
        const status = mapUpstreamErrorStatus(e, clientAborted);
        const hadFailover = !!e.trail && e.trail.some((s) => s.outcome === 'failed');
        const traced = maybeSaveRequestTrace({
          requestId, c, body: rawClientBody, route: route.id,
          provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
          upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
          hadFailover,
        });
        const meta = errorMetadata(e);
        if (traced && meta) meta.hasTrace = true;
        logRequest({
          ...baseLog,
          status,
          latencyMs: Math.round(performance.now() - startedAt),
          provider: e.servedBy?.provider ?? null,
          model: e.servedBy?.model ?? null,
          upstreamKeyId: e.servedBy?.keyId ?? null,
          errorCode: clientAborted ? 'client_closed_request' : e.code ?? null,
          errorMessage: (clientAborted ? 'Client disconnected before the request completed.' : e.message ?? String(e)).slice(0, 500),
          metadata: meta,
        });
      };

      const readable = new ReadableStream<Uint8Array>({
        async start(streamController) {
          let heartbeat: ReturnType<typeof setInterval> | null = null;
          const enqueue = (chunk: string | Uint8Array) => {
            try {
              streamController.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
              return true;
            } catch {
              return false;
            }
          };
          const close = () => {
            try {
              streamController.close();
            } catch {
              /* already closed/cancelled */
            }
          };

          enqueue(': connected\n\n');
          heartbeat = setInterval(() => {
            enqueue(': ping\n\n');
          }, heartbeatMs);

          try {
            // For large-context requests, executeRoute can spend a long time
            // before upstream sends headers. The heartbeat above keeps the
            // client/proxy connection from looking idle during that phase.
            injectSignaturesIntoMessages(body.messages);
            injectReasoningIntoMessages(body.messages);
            const { response, servedBy, trail, servedByKeyId } = await executeRoute(config, route, body, controller.signal);
            const upstreamKeyId = servedByKeyId ?? null;
            const effectiveModality = servedBy.modality ?? route.modality ?? 'chat';
            const isResponsesModality = effectiveModality === 'responses';
            const isToolsTextModality = effectiveModality === 'tools-text'
              || effectiveModality === 'tools-text-stream'
              || effectiveModality === 'tools-text-nonstream';
            const upstreamModelForLog = servedBy.modelId.startsWith(`${servedBy.providerId}/`)
              ? servedBy.modelId.slice(servedBy.providerId.length + 1)
              : servedBy.modelId;
            const toolsTextPromptEstimate = isToolsTextModality && servedBy.providerId === 'gemini'
              ? estimateTokens(JSON.stringify(convertChatRequestToToolsText(body).messages ?? body.messages ?? ''))
              : undefined;
            const { response: streamRes, done } = isToolsTextModality
              ? proxyToolsTextSSEStream(c, response, upstreamModelForLog, {
                providerId: servedBy.providerId,
                promptTokenEstimate: toolsTextPromptEstimate,
                bufferToolArgs: effectiveModality === 'tools-text-nonstream',
              })
              : isResponsesModality
                ? proxyResponsesSSEStream(c, response, upstreamModelForLog)
                : proxySSEStream(c, response, servedBy.providerId);
            innerLogAttached = true;
            done.then((res) => logStreamResult(res, servedBy, trail, upstreamKeyId));

            activeReader = streamRes.body?.getReader() ?? null;
            if (!activeReader) throw new Error('Upstream returned no stream body.');
            while (true) {
              const { done: rd, value } = await activeReader.read();
              if (rd) break;
              if (value) enqueue(value);
            }
          } catch (err) {
            if (!innerLogAttached) logStreamFailure(err);
            if (!clientAborted) {
              const msg = err instanceof Error ? err.message : 'Upstream stream error.';
              enqueue(`data: ${JSON.stringify({ error: { message: msg, type: 'upstream_error' } })}\n\n`);
              enqueue('data: [DONE]\n\n');
            }
          } finally {
            if (heartbeat) clearInterval(heartbeat);
            close();
          }
        },
        cancel() {
          clientAborted = true;
          controller.abort();
          activeReader?.cancel().catch(() => {});
        },
      });

      return c.newResponse(readable, 200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    try {
      // Inject Gemini thought_signature balik ke body.messages utk multi-turn
      // tool calling. No-op bila cache kosong (provider non-Gemini / turn pertama).
      injectSignaturesIntoMessages(body.messages);
      injectReasoningIntoMessages(body.messages);
      const { response, servedBy, latencyMs, trail, servedByKeyId } = await executeRoute(config, route, body, controller.signal);
      const upstreamKeyId = servedByKeyId ?? null;

      // Route/target modality 'responses': upstream menerima/mengembalikan format
      // Responses API, tapi client tetap format chat/completions. Convert di gateway.
      // Pakai servedBy.modality (override per-target) bila ada; fallback route.modality.
      // Ini krusial: jika target OpenAI responses sukses setelah failover, gateway
      // harus convert — walau route.modality mungkin 'chat'.
      const effectiveModality = servedBy.modality ?? route.modality ?? 'chat';
      const isResponsesModality = effectiveModality === 'responses';
      const isToolsTextModality = effectiveModality === 'tools-text'
        || effectiveModality === 'tools-text-stream'
        || effectiveModality === 'tools-text-nonstream';
      // Model id upstream = strip prefix provider (sama dgn yg dikirim adapter).
      const upstreamModelForLog = servedBy.modelId.startsWith(`${servedBy.providerId}/`)
        ? servedBy.modelId.slice(servedBy.providerId.length + 1)
        : servedBy.modelId;

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
        const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
        logRequest({
          ...baseLog,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          upstreamKeyId,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          metadata: successTraced ? { trail, hasTrace: true } : { trail },
        });
        return c.json(chatJson);
      }

      if (isToolsTextModality) {
        // tools-text: response content mengandung <tool_call> XML → parse ke
        // OpenAI tool_calls. Bila tidak ada tag, kirim sbg text biasa.
        const ttJson = (await response.json()) as Record<string, unknown>;
        const chatJson = convertToolsTextToChat(ttJson, upstreamModelForLog);
        const promptTokens = chatJson.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
        const completionTokens = chatJson.usage?.completion_tokens ?? 0;
        const totalTokens = chatJson.usage?.total_tokens ?? promptTokens + completionTokens;
        const model = config.models.find((m) => m.id === servedBy.modelId);
        const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
        const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
        logRequest({
          ...baseLog,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          upstreamKeyId,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          metadata: successTraced ? { trail, hasTrace: true } : { trail },
        });
        return c.json(chatJson);
      }

      // Non-streaming chat default: passthrough JSON, extract usage.
      const json = (await response.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        choices?: Array<{ message?: { tool_calls?: ToolCall[]; extra_content?: unknown } }>;
      };
      // Capture + strip Gemini thought_signature dari tool_calls response (sebelum
      // kirim ke client). Supaya multi-turn jalan & client dapat format OpenAI murni.
      for (const choice of json.choices ?? []) {
        captureAndStripToolCalls(choice?.message?.tool_calls, servedBy.providerId);
        // Strip extra_content di top-level message juga (Gemini reasoning signature).
        stripMessageExtraContent(choice?.message);
        // DeepSeek reasoning_content: capture by content-hash + strip dari response.
        captureAndStripReasoning(choice?.message, servedBy.providerId);
      }
      const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''));
      const completionTokens = json.usage?.completion_tokens ?? 0;
      const totalTokens = json.usage?.total_tokens ?? promptTokens + completionTokens;
      const model = config.models.find((m) => m.id === servedBy.modelId);
      const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, promptTokens, completionTokens);
      const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
      logRequest({
        ...baseLog,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
        metadata: successTraced ? { trail, hasTrace: true } : { trail },
      });
      return c.json(json);
    } catch (err) {
      const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; trail?: import('@sibergate/core').FailoverStep[]; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
      const status = mapUpstreamErrorStatus(e, clientAborted);
      const latencyMs = Math.round(performance.now() - startedAt);
      const hadFailover = !!e.trail && e.trail.some((s) => s.outcome === 'failed');
      const traced = maybeSaveRequestTrace({
        requestId, c, body: rawClientBody, route: route.id,
        provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
        upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
        hadFailover,
      });
      const meta = errorMetadata(e);
      if (traced && meta) meta.hasTrace = true;
      logRequest({
        ...baseLog,
        status,
        latencyMs,
        provider: e.servedBy?.provider ?? null,
        model: e.servedBy?.model ?? null,
        upstreamKeyId: e.servedBy?.keyId ?? null,
        errorCode: clientAborted ? 'client_closed_request' : e.code ?? null,
        errorMessage: (clientAborted ? 'Client disconnected before the request completed.' : e.message ?? String(e)).slice(0, 500),
        metadata: meta,
      });
      const type =
        clientAborted ? 'client_closed_request' : e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
      return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
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

  // Per-target timeout is enforced inside executeRoute. This parent controller
  // only propagates a client disconnect.
  const controller = new AbortController();
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  emitIncoming(c, route.id, modality);

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
    apiKeyId: c.get('apiKeyId') ?? null,
  };

  try {
    const { response, servedBy, latencyMs, servedByKeyId } = await executeRoute(config, route, body, controller.signal);
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
      upstreamKeyId: servedByKeyId ?? null,
      latencyMs,
      costUsd,
    });
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': upstreamContentType, 'Content-Length': String(buf.length) },
    });
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
    const status = mapUpstreamErrorStatus(e);
    const latencyMs = Math.round(performance.now() - startedAt);
    const traced = maybeSaveRequestTrace({
      requestId, c, body, route: route.id,
      provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
      upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
      hadFailover: false,
    });
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: e.servedBy?.model ?? null,
      upstreamKeyId: e.servedBy?.keyId ?? null,
      errorCode: e.code ?? null,
      errorMessage: (e.message ?? String(e)).slice(0, 500),
      metadata: traced ? { hasTrace: true } : undefined,
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
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

  emitIncoming(c, route.id, 'image');

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
    apiKeyId: c.get('apiKeyId') ?? null,
  };

  try {
    const { response, servedBy, latencyMs, servedByKeyId } = await executeRoute(config, route, body, controller.signal);
    const upstreamKeyId = servedByKeyId ?? null;
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
      // Async: poll sampai sukses atau gagal. Provider harus dipakai dgn key yg
      // sama dgn request awal (servedBy.keyId) — clone utk polling bila perlu.
      const baseProvider = config.providers.find((p) => p.id === servedBy.providerId);
      if (!baseProvider) {
        // Provider hilang di config (mis. baru di-disable). Teruskan apa adanya.
        return new Response(buf, { status: 200, headers: { 'Content-Type': upstreamContentType } });
      }
      const key = servedBy.keyId
        ? config.providerKeys.find((k) => k.id === servedBy.keyId && k.enabled)
        : null;
      const provider = key ? { ...baseProvider, apiKey: key.value } : baseProvider;
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
          upstreamKeyId,
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
        upstreamKeyId,
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
      upstreamKeyId,
      latencyMs,
      costUsd,
    });
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': upstreamContentType, 'Content-Length': String(buf.length) },
    });
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
    const status = mapUpstreamErrorStatus(e);
    const latencyMs = Math.round(performance.now() - startedAt);
    const traced = maybeSaveRequestTrace({
      requestId, c, body, route: route.id,
      provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
      upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
      hadFailover: false,
    });
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: e.servedBy?.model ?? null,
      upstreamKeyId: e.servedBy?.keyId ?? null,
      errorCode: e.code ?? null,
      errorMessage: e.message?.slice(0, 300),
      metadata: traced ? { hasTrace: true } : undefined,
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

  emitIncoming(c, route.id, 'generic');

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

  // Per-target timeout is enforced inside executeRoute. This parent controller
  // only propagates a client disconnect.
  const controller = new AbortController();
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
    apiKeyId: c.get('apiKeyId') ?? null,
  };

  try {
    const { response, servedBy, latencyMs, servedByKeyId } = await executeRoute(config, route, body, controller.signal);

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
      upstreamKeyId: servedByKeyId ?? null,
      latencyMs,
      costUsd,
    });
    return new Response(buf, {
      status: response.status,
      headers: respHeaders,
    });
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
    const status = mapUpstreamErrorStatus(e);
    const latencyMs = Math.round(performance.now() - startedAt);
    const traced = maybeSaveRequestTrace({
      requestId, c, body, route: route.id,
      provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
      upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
      hadFailover: false,
    });
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: e.servedBy?.model ?? null,
      upstreamKeyId: e.servedBy?.keyId ?? null,
      errorCode: e.code ?? null,
      errorMessage: (e.message ?? String(e)).slice(0, 500),
      metadata: traced ? { hasTrace: true } : undefined,
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
  }
}
