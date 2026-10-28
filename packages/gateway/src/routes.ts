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
  saveRequestTrace,
  type RequestTraceData,
  type RouteModality,
  type Route,
  type SiberGateConfig,
  type VideoJob,
  resolveProxy,
  buildTransport,
  mcpToolsList,
  pollMcpTaskOnce,
  admin,
} from '@sibergate/core';
import { authMiddleware, requestIdMiddleware, type Vars } from './middleware.js';
import { proxySSEStream, proxyResponsesSSEStream, proxyToolsTextSSEStream } from './stream.js';
import { errorResponse, mapUpstreamErrorStatus } from './errors.js';
import {
  isAsyncTaskResponse,
  buildPollUrl,
  pollTaskUntilDone,
  buildOpenAIImageResponse,
  isDashScopeTaskResponse,
  isDashScopeImageBody,
  buildDashScopePollUrl,
  pollDashScopeTaskUntilDone,
  convertDashScopeImageBody,
} from './image-task.js';

/**
 * Build audit-log metadata for an upstream failure, merging the failover trail
 * with the failing upstream diagnostics (URL/status/body) when present.
 */
function enforceApiRoute(c: Context, routeId: string): Response | null {
  const allowed = c.get('apiKeyRouteIds');
  if (allowed && !allowed.includes(routeId)) {
    return errorResponse(c, 403, `API key is not allowed to access route '${routeId}'.`, 'permission_error');
  }
  return null;
}

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

/**
 * Client headers that are SAFE to forward to the upstream provider. This is a
 * strict allowlist: anything not listed here is dropped (secrets, internal
 * proxy headers, etc.). Operators who need a custom header to reach the LLM
 * can set it statically per-provider (provider.headers in the DB), or extend
 * this list. Configurable via SIBERGATE_PASSTHROUGH_HEADERS (comma-separated).
 */
const DEFAULT_PASSTHROUGH = [
  'user-agent',
  'http-referer',   // OpenRouter attribution
  'x-title',        // OpenRouter app title
  'x-request-id',
  'accept-language',
];
const PASSTHROUGH_HEADERS: ReadonlySet<string> = new Set(
  (process.env.SIBERGATE_PASSTHROUGH_HEADERS?.split(',').map((s) => s.trim().toLowerCase()) ?? DEFAULT_PASSTHROUGH)
    .filter(Boolean),
);

/** Extract allowlisted client headers for forwarding to the upstream. */
function extractPassthroughHeaders(c: Context): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    if (PASSTHROUGH_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

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

/** Keep uploaded image bytes out of raw traces while retaining field shape. */
function redactImageDataForTrace(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/data:(image\/[^;,\s]+);base64,([A-Za-z0-9+/=\r\n]+)/gi, (_match, mimeType: string, data: string) =>
      `data:${mimeType};base64,[redacted ${data.replace(/\s/g, '').length} chars]`,
    );
  }
  if (Array.isArray(value)) return value.map(redactImageDataForTrace);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactImageDataForTrace(item)]));
  }
  return value;
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
  /**
   * Simpan trace TANPA syarat (dipakai error-path handler: semua respons
   * non-200 wajib menyimpan request yg dikirim — termasuk 400 validasi
   * tanpa diagnostik upstream — supaya bisa dilihat di drawer detail log).
   */
  force?: boolean;
}): boolean {
  // Only capture when there was an actual upstream error (final failure or a
  // recovered failover) — or when explicitly forced (non-200 responses).
  // Success requests are not traced (disk hygiene).
  const upstreamPresent = opts.upstreamUrl || opts.upstreamStatus != null;
  if (!opts.force && !opts.hadFailover && !upstreamPresent) return false;
  try {
    const traceBody = opts.c.req.path.startsWith('/v1/images/')
      ? redactImageDataForTrace(opts.upstreamRequestBody ?? opts.body)
      : opts.upstreamRequestBody ?? opts.body;
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
      body: traceBody,
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

/* ─── DeepSeek thinking-mode reasoning_content ────────────────────────────
 * DeepSeek thinking-mode mengembalikan field non-standard `reasoning_content`.
 * Aturan resmi (api-docs.deepseek.com/guides/thinking_mode): utk assistant
 * message DENGAN tool_calls, reasoning_content WAJIB di-pass back di request
 * multi-turn berikutnya. Kalau hilang → 400 "reasoning_content must be passed
 * back".
 *
 * Pendekatan sederhana & stateless:
 *   1. Response: STRIP reasoning_content dari response ke client (format
 *      OpenAI murni). Tidak di-cache.
 *   2. Request: utk SEMUA assistant messages DENGAN tool_calls, inject
 *      reasoning_content = " " (placeholder satu spasi). DeepSeek menerima
 *      placeholder non-valid (validasi longgar saat ini), dan ini menutup
 *      celah cross-vendor (Qwen/Gemini history tidak punya reasoning DeepSeek).
 *      Tidak perlu cache, tidak ada hash miss, tidak hilang saat restart.
 */

/** Strip reasoning_content dari response message supaya client format OpenAI murni. */
function captureAndStripReasoning(message: Record<string, unknown> | undefined | null): void {
  if (!message) return;
  if (message.reasoning_content !== undefined) delete message.reasoning_content;
}

/** Inject placeholder reasoning_content (" ") ke SEMUA assistant messages dgn tool_calls.
 *  Mencegah error DeepSeek "reasoning_content must be passed back" saat history
 *  campur vendor atau setelah gateway strip reasoning dari response. Stateless —
 *  tidak butuh cache, tidak hilang saat restart. */
function injectPlaceholderReasoning(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    const msg = m as { role?: string; tool_calls?: unknown[]; reasoning_content?: unknown };
    if (msg?.role !== 'assistant') continue;
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    // Sudah ada reasoning_content (non-empty)? biarkan — client mungkin kirim asli.
    if (msg.reasoning_content === undefined || msg.reasoning_content === '') {
      msg.reasoning_content = ' ';
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

  // Public self-description for clients/AI agents: explains what the service is
  // and how to call it WITHOUT enumerating internal providers or route ids
  // (those are discovered via GET /v1/models, which is gated by client auth).
  app.get('/', (c) => {
    return c.json({
      name: 'SiberGate',
      version: '0.1.0',
      status: 'ok',
      description:
        'Self-hosted, OpenAI-compatible AI gateway with smart routing (fallback, fastest, load balancing).',
      auth: {
        scheme: 'bearer',
        header: 'Authorization: Bearer <API_KEY>',
        key_prefix: 'sg_live_',
        note: 'All /v1/* endpoints require a valid API key unless the gateway has no keys configured (open mode).',
      },
      endpoints: {
        discover_models: 'GET /v1/models',
        chat: 'POST /v1/chat/completions',
        images_generations: 'POST /v1/images/generations',
        images_edits: 'POST /v1/images/edits',
        audio_speech: 'POST /v1/audio/speech',
        audio_transcriptions: 'POST /v1/audio/transcriptions',
        embeddings: 'POST /v1/embeddings',
        music_generations: 'POST /v1/music/generations',
        videos_create: 'POST /v1/videos',
        videos_status: 'GET /v1/videos/:id',
        videos_content: 'GET /v1/videos/:id/content',
        mcp_tools: 'GET /v1/mcp/:routeId/tools',
        mcp_tool_call: 'POST /v1/mcp/:routeId/tools/:toolName',
        generic_proxy: 'ANY /v1/generic/*',
        custom_script: 'ANY /api/custom/:id',
      },
      health: 'GET /health',
      docs: 'See README.md for the full API reference.',
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
    const passthroughHeaders = extractPassthroughHeaders(c);
    const startedAt = c.get('startedAt');

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return errorResponse(c, 400, 'Request body must be valid JSON.', 'invalid_request_error');
    // Snapshot the pristine client body BEFORE any mutation (inject signatures/
    // reasoning mutates body.messages in place). The snapshot is used only for
    // the raw request trace when an error occurs.
    const rawClientBody = structuredClone(body);

    const routeId = String(body.model ?? '');
    const routeAccessError = enforceApiRoute(c, routeId);
    if (routeAccessError) return routeAccessError;
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
        // DeepSeek streaming reasoning_content: di-strip dari stream (di
        // DeepSeek streaming reasoning_content: di teruskan apa adanya ke client
        // (verbatim mode). Tidak perlu capture/cache — di request berikutnya,
        // injectPlaceholderReasoning inject " " utk tool_calls messages.
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
          force: true,
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
            injectPlaceholderReasoning(body.messages);
            const { response, servedBy, trail, servedByKeyId } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
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
      injectPlaceholderReasoning(body.messages);
      const { response, servedBy, latencyMs, trail, servedByKeyId } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
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
        captureAndStripReasoning(choice?.message);
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
        force: true,
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
   * Pengecualian: endpoint generations dan edits memakai imageHandler. Handler
   * juga menangani async task-based provider (mis. Kling AI) dan mengubah
   * upload multipart edits menjadi data URL kanonik sebelum adapter memetakan
   * request ke dialek target.
   */
  app.post('/v1/images/generations', (c) => imageHandler(c, configStore));
  app.post('/v1/images/edits', (c) => imageHandler(c, configStore, { edits: true }));
  app.post('/v1/audio/speech', (c) => modalityHandler(c, configStore, 'speech', '/v1/audio/speech'));
  app.post('/v1/audio/transcriptions', (c) => modalityHandler(c, configStore, 'transcribe', '/v1/audio/transcriptions'));
  app.post('/v1/embeddings', (c) => modalityHandler(c, configStore, 'embed', '/v1/embeddings'));
  // SiberGate extension — text-to-music (e.g. DeepInfra ACE-Step).
  app.post('/v1/music/generations', (c) => modalityHandler(c, configStore, 'music', '/v1/music/generations'));

  // SiberGate extension — OpenAI-style video generation (Sora-shaped API,
  // /v1/videos). Dibackend provider MCP (mis. Kling text_to_video): POST submit
  // → job id; GET poll status (via tool polling query_tasks); GET content
  // stream mp4; DELETE hapus job lokal.
  app.post('/v1/videos', (c) => videoCreateHandler(c, configStore));
  app.get('/v1/videos/:id', (c) => videoStatusHandler(c, configStore));
  app.get('/v1/videos/:id/content', (c) => videoContentHandler(c, configStore));
  app.delete('/v1/videos/:id', (c) => videoDeleteHandler(c, configStore));

  // SiberGate extension — generic MCP tool invocation. Route (modality 'mcp')
  // memilih provider MCP; tool dipilih dari URL. Body = arguments tool apa
  // adanya (atau {"arguments": {...}}). Respons = hasil tools/call
  // ternormalisasi — cocok utk tool di luar image/video (element_*, dll.).
  app.get('/v1/mcp/:routeId/tools', (c) => mcpListToolsHandler(c, configStore));
  app.post('/v1/mcp/:routeId/tools/:toolName', (c) => mcpCallToolHandler(c, configStore));

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
  const passthroughHeaders = extractPassthroughHeaders(c);
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
  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;
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
    const { response, servedBy, latencyMs, servedByKeyId, trail } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
    const upstreamContentType = response.headers.get('content-type') ?? 'application/json';

    // Forward the body verbatim with the upstream Content-Type (binary or JSON).
    const buf = Buffer.from(await response.arrayBuffer());
    // Non-chat modalities don't carry token usage today, so cost stays 0 until
    // per-modality pricing (per-image/per-second) is wired. The lookup is here
    // so filling a model's price later makes it count with no code change.
    const model = config.models.find((m) => m.id === servedBy.modelId);
    const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
    // Trail failover disertakan di metadata (auto-set had_failover oleh logger)
    // + raw trace saat ada target yg gagal — konsisten dgn handler chat.
    const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      upstreamKeyId: servedByKeyId ?? null,
      latencyMs,
      costUsd,
      metadata: successTraced ? { trail, hasTrace: true } : { trail },
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
      force: true,
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
 * Image handler untuk /v1/images/generations dan /v1/images/edits. Mendukung dua jenis provider:
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
function isUploadedImage(value: FormDataEntryValue): value is File {
  return typeof value !== 'string' && typeof value.arrayBuffer === 'function' && typeof value.name === 'string';
}

function uploadedImageMimeType(file: File): string {
  const supplied = file.type.trim().toLowerCase().split(';', 1)[0] ?? '';
  if (supplied.startsWith('image/')) return supplied === 'image/jpg' ? 'image/jpeg' : supplied;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const byExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  };
  const mimeType = byExtension[extension];
  if (!mimeType) throw new Error(`Uploaded image '${file.name}' must have an image MIME type.`);
  return mimeType;
}

async function parseImageEditsForm(c: Context): Promise<Record<string, unknown> | null> {
  const contentType = c.req.header('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(contentType)) return null;
  const form = await c.req.formData().catch(() => null);
  if (!form) return null;

  const body: Record<string, unknown> = {};
  const images: string[] = [];
  for (const [name, value] of form.entries()) {
    if (name === 'image' || name === 'image[]') {
      if (typeof value === 'string') {
        if (value.trim()) images.push(value.trim());
      } else if (isUploadedImage(value)) {
        const mimeType = uploadedImageMimeType(value);
        const bytes = Buffer.from(await value.arrayBuffer());
        if (!bytes.length) throw new Error(`Uploaded image '${value.name}' is empty.`);
        images.push(`data:${mimeType};base64,${bytes.toString('base64')}`);
      }
      continue;
    }

    if (name === 'mask' && isUploadedImage(value)) {
      const mimeType = uploadedImageMimeType(value);
      const bytes = Buffer.from(await value.arrayBuffer());
      body.mask = `data:${mimeType};base64,${bytes.toString('base64')}`;
      continue;
    }
    if (typeof value === 'string') body[name] = name === 'n' ? Number(value) : value;
  }
  if (!images.length) return null;
  body.image = images.length === 1 ? images[0] : images;
  return body;
}

async function imageHandler(c: Context, configStore: ConfigStore, { edits = false }: { edits?: boolean } = {}) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');
  const passthroughHeaders = extractPassthroughHeaders(c);
  const path = edits ? '/v1/images/edits' : '/v1/images/generations';

  let parsed: Record<string, unknown> | null;
  try {
    parsed = edits
      ? await parseImageEditsForm(c)
      : await c.req.json().catch(() => null);
  } catch (error) {
    return errorResponse(c, 400, (error as Error).message, 'invalid_request_error', 'invalid_image_upload', 'image');
  }
  if (!parsed) {
    const message = edits
      ? 'Request body must be valid multipart/form-data and include at least one image file.'
      : 'Request body must be valid JSON.';
    return errorResponse(c, 400, message, 'invalid_request_error');
  }

  const body = parsed as Record<string, unknown>;
  // Route id boleh dikirim via `model` (OpenAI) ATAU `model_name` (dialek
  // Kling) — dua ejaan utk maksud yg sama (route masked; nilai client tidak
  // pernah diteruskan ke upstream, adapter selalu inject model asli target).
  const routeId = String(body.model ?? body.model_name ?? '');
  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;
  let route: Route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }
  if (edits) {
    // The public edit endpoint is OpenAI-shaped. Always translate its uploaded
    // files to the target image provider's edit dialect, regardless of the
    // route target's default body-mapping setting.
    route = { ...route, targets: route.targets.map((target) => ({ ...target, mapping: 'auto' })) };
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
    const { response, servedBy, latencyMs, servedByKeyId, trail } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
    const upstreamKeyId = servedByKeyId ?? null;
    // Trail failover utk metadata log sukses (auto-set had_failover logger) —
    // konsisten dgn handler chat; raw trace tersimpan bila ada target gagal.
    const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
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

    // Mapping mode target yg menang (dari route target; 'auto' hanya bila
    // eksplisit di-set operator). Menentukan converter response mana yg aktif.
    const autoMapping = servedBy.mapping === 'auto';

    /** Resolve provider utk polling: clone dgn key yg sama dgn request awal. */
    const resolvePollProvider = () => {
      const baseProvider = config.providers.find((p) => p.id === servedBy.providerId);
      if (!baseProvider) return null;
      const key = servedBy.keyId
        ? config.providerKeys.find((k) => k.id === servedBy.keyId && k.enabled)
        : null;
      return key ? { ...baseProvider, apiKey: key.value } : baseProvider;
    };
    /** Polling lewat proxy bila provider di-bind (konsisten dgn call awal). */
    const resolvePollDispatcher = (baseUrl: string): unknown => {
      const resolvedPoll = resolveProxy(servedBy.providerId, route.id);
      if (!resolvedPoll) return undefined;
      try {
        return buildTransport(resolvedPoll, baseUrl).dispatcher;
      } catch {
        return undefined; // fail-open: poll tanpa proxy
      }
    };
    /** Log + return response OpenAI hasil polling sukses. */
    const finishPolled = (images: Array<{ url: string; revised_prompt?: string }>) => {
      const totalLatency = Math.round(performance.now() - startedAt);
      const model = config.models.find((m) => m.id === servedBy.modelId);
      const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
      logRequest({
        ...baseLog,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        upstreamKeyId,
        latencyMs: totalLatency,
        costUsd,
        metadata: successTraced ? { trail, hasTrace: true } : { trail },
      });
      return c.json(buildOpenAIImageResponse(images));
    };
    /** Log + return 502 OpenAI-compat error saat polling gagal. */
    const failPolled = (message: string) => {
      const totalLatency = Math.round(performance.now() - startedAt);
      const model = config.models.find((m) => m.id === servedBy.modelId);
      const costUsd = computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0);
      logRequest({
        ...baseLog,
        status: 502,
        latencyMs: totalLatency,
        provider: servedBy.providerId,
        model: servedBy.modelId,
        upstreamKeyId,
        errorCode: 'image_task_failed',
        errorMessage: message?.slice(0, 300),
        costUsd,
        metadata: successTraced ? { trail, hasTrace: true } : { trail },
      });
      return errorResponse(
        c, 502,
        `Image task failed: ${message}`,
        'upstream_error',
        'image_task_failed',
        'image_generation',
      );
    };

    if (isAsyncTaskResponse(taskBody)) {
      // Async gaya Kling (data.task_id): poll sampai sukses atau gagal.
      const provider = resolvePollProvider();
      if (!provider) {
        // Provider hilang di config (mis. baru di-disable). Teruskan apa adanya.
        return new Response(buf, { status: 200, headers: { 'Content-Type': upstreamContentType } });
      }
      const pollUrl = buildPollUrl(provider, taskBody.data.task_id);
      const outcome = await pollTaskUntilDone(provider, pollUrl, {
        signal: controller.signal,
        dispatcher: resolvePollDispatcher(provider.baseUrl),
      });
      if (outcome.status === 'succeed') return finishPolled(outcome.images);
      return failPolled(outcome.message);
    }

    if (autoMapping && isDashScopeTaskResponse(taskBody)) {
      // Async gaya DashScope (output.task_id — Qwen via header async / Kling
      // via Alibaba Model Studio). Poll endpoint generik /api/v1/tasks/{id}.
      // Hanya aktif utk mapping='auto' (bentuk non-OpenAI; mode verbatim
      // meneruskan apa adanya sesuai kontraknya).
      const provider = resolvePollProvider();
      if (!provider) {
        return new Response(buf, { status: 200, headers: { 'Content-Type': upstreamContentType } });
      }
      const pollUrl = buildDashScopePollUrl(provider, taskBody.output.task_id);
      const outcome = await pollDashScopeTaskUntilDone(provider, pollUrl, {
        signal: controller.signal,
        dispatcher: resolvePollDispatcher(provider.baseUrl),
      });
      if (outcome.status === 'succeed') return finishPolled(outcome.images);
      return failPolled(outcome.message);
    }

    if (autoMapping && taskBody && isDashScopeImageBody(taskBody)) {
      // Qwen-Image synchronous: response langsung berisi gambar dalam bentuk
      // output.choices[].message.content[].image → convert ke OpenAI shape.
      const converted = convertDashScopeImageBody(taskBody as Record<string, unknown>);
      if (converted) {
        // Audit log — sama seperti jalur polling & verbatim (dulu lupa: request
        // sukses lewat jalur ini tidak pernah masuk tabel requests, hanya muncul
        // di Console). latencyMs = latency upstream sync dari executeRoute.
        const model = config.models.find((m) => m.id === servedBy.modelId);
        logRequest({
          ...baseLog,
          provider: servedBy.providerId,
          model: servedBy.modelId,
          upstreamKeyId,
          latencyMs,
          costUsd: computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0),
          metadata: successTraced ? { trail, hasTrace: true } : { trail },
        });
        return c.json(converted);
      }
      // Tidak ada gambar ditemukan (bentuk tak terduga) → jatuh ke verbatim.
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
      metadata: successTraced ? { trail, hasTrace: true } : { trail },
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
      force: true,
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

/* ─────────────────────────────────────────────────────────────────────────
 * VIDEO (modality 'video') — OpenAI-style /v1/videos, dibackend provider MCP.
 *
 * POST   /v1/videos            → submit tool generasi (mis. text_to_video);
 *                                bila async (generation_id) → job status
 *                                queued + id; bila sync → langsung completed.
 * GET    /v1/videos/:id        → poll tool polling (query_tasks) sekali lalu
 *                                balas status OpenAI video object.
 * GET    /v1/videos/:id/content→ stream bytes mp4 dari URL aset final.
 * DELETE /v1/videos/:id        → hapus job lokal (task upstream tak bisa
 *                                dibatalkan — catatan di README).
 * ───────────────────────────────────────────────────────────────────────── */

/** Bentuk objek video ala OpenAI (Sora API) dari job row. */
function videoJobToObject(job: VideoJob): Record<string, unknown> {
  const request = (job.result as { __request?: Record<string, unknown> } | null)?.__request ?? {};
  const createdEpoch = Math.floor(new Date(job.createdAt.replace(' ', 'T') + 'Z').getTime() / 1000);
  return {
    id: job.id,
    object: 'video',
    created_at: createdEpoch,
    status: job.status,
    progress: job.progress,
    model: job.modelId,
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
    ...(request.size !== undefined ? { size: request.size } : {}),
    // SiberGate extension (non-standar): jejak task upstream + URL hasil.
    sibergate: {
      provider: job.providerId,
      task_ref: job.taskRef,
      poll_tool: job.pollTool,
      ...(job.videoUrls.length ? { video_urls: job.videoUrls } : {}),
    },
    ...(job.status === 'failed' && job.error ? { error: { message: job.error } } : {}),
  };
}

/** URL video final dari payload ternormalisasi (fallback otherUrls tanpa ekstensi). */
function pickVideoUrls(payload: { videoUrls: string[]; otherUrls: string[] }): string[] {
  if (payload.videoUrls.length) return payload.videoUrls;
  return payload.otherUrls.filter((u) => /^https?:\/\//.test(u));
}

/** Access control: API key pembuat request harus boleh mengakses route job. */
function enforceVideoJobAccess(c: Context, job: VideoJob): Response | null {
  const allowed = c.get('apiKeyRouteIds');
  if (allowed && !allowed.includes(job.routeId)) {
    return errorResponse(c, 403, `API key is not allowed to access route '${job.routeId}'.`, 'permission_error');
  }
  return null;
}

async function videoCreateHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');
  const passthroughHeaders = extractPassthroughHeaders(c);
  const path = '/v1/videos';

  const parsed = await c.req.json().catch(() => null);
  if (!parsed) return errorResponse(c, 400, 'Request body must be valid JSON.', 'invalid_request_error');
  const body = parsed as Record<string, unknown>;

  const routeId = String(body.model ?? '');
  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;
  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Model/route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found', 'model');
  }
  if ((route.modality ?? 'chat') !== 'video') {
    return errorResponse(
      c, 400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not a video route.`,
      'invalid_request_error', 'modality_mismatch', 'model',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route.timeoutMs ?? 60_000);
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  emitIncoming(c, route.id, 'video');

  const baseLog = {
    requestId,
    method: 'POST',
    path,
    route: route.id,
    strategy: route.strategy,
    modality: 'video' as RouteModality,
    streamed: false,
    status: 200,
    latencyMs: 0,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    apiKeyId: c.get('apiKeyId') ?? null,
  };

  try {
    const { response, servedBy, latencyMs, servedByKeyId, trail } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
    const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
    // Adapter video (MCP) mengembalikan payload ternormalisasi (JSON).
    const payload = (await response.json().catch(() => null)) as
      | { taskRef?: string | null; status?: string | null; videoUrls?: string[]; otherUrls?: string[]; text?: string; taskStatus?: string | null }
      | null;
    if (!payload) {
      throw Object.assign(new Error('Video adapter returned a non-JSON body.'), { code: 'server_error' });
    }
    const failed = payload.status === 'failed';
    const completed = payload.status === 'completed'
      || (!payload.taskRef && (payload.videoUrls?.length || payload.otherUrls?.length));
    const pollTool = config.providers.find((p) => p.id === servedBy.providerId)?.mcpOptions?.pollTool ?? null;
    const job = admin.createVideoJob({
      routeId: route.id,
      providerId: servedBy.providerId,
      modelId: servedBy.modelId,
      pollTool,
      taskRef: payload.taskRef ?? null,
      status: failed ? 'failed' : completed ? 'completed' : ((payload.status as VideoJob['status']) ?? 'queued'),
      result: {
        // Echo request utk objek video (prompt/seconds/size) — dipertahankan
        // saat update poll (merge by key __request).
        __request: { prompt: body.prompt, seconds: body.seconds, size: body.size },
        ...payload,
      },
      videoUrls: completed ? pickVideoUrls(payload as { videoUrls: string[]; otherUrls: string[] }) : [],
      apiKeyId: c.get('apiKeyId') ?? null,
    });
    const model = config.models.find((m) => m.id === servedBy.modelId);
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      model: servedBy.modelId,
      upstreamKeyId: servedByKeyId ?? null,
      latencyMs,
      costUsd: computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0),
      metadata: successTraced ? { trail, hasTrace: true } : { trail },
    });
    return c.json(videoJobToObject(job));
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; servedBy?: { provider: string; model: string; keyId?: string | null }; upstream?: { url?: string; status?: number; body?: string | null; requestBody?: string | null; requestHeaders?: Record<string,string> | null } };
    const status = mapUpstreamErrorStatus(e);
    const latencyMs = Math.round(performance.now() - startedAt);
    const traced = maybeSaveRequestTrace({
      requestId, c, body, route: route.id,
      provider: e.servedBy?.provider ?? null, model: e.servedBy?.model ?? null,
      upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
      hadFailover: false,
      force: true,
    });
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: e.servedBy?.model ?? null,
      upstreamKeyId: e.servedBy?.keyId ?? null,
      errorCode: e.code ?? null,
      errorMessage: (e.message ?? String(e)).slice(0, 300),
      metadata: traced ? { hasTrace: true } : undefined,
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null, 'video_generation');
  } finally {
    clearTimeout(timeout);
  }
}

async function videoStatusHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const id = String(c.req.param('id'));
  let job = admin.getVideoJob(id);
  if (!job) {
    return errorResponse(c, 404, `Video '${id}' not found.`, 'invalid_request_error', 'video_not_found');
  }
  const accessError = enforceVideoJobAccess(c, job);
  if (accessError) return accessError;

  // Poll sekali per GET selama task masih berjalan (klien yang mengatur ritme
  // polling — sama seperti pola OpenAI Videos API).
  if ((job.status === 'queued' || job.status === 'in_progress') && job.taskRef && job.pollTool) {
    const provider = config.providers.find((p) => p.id === job!.providerId && p.enabled && p.protocol === 'mcp');
    if (provider) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let normalized;
        try {
          normalized = await pollMcpTaskOnce(
            provider,
            { pollTool: job!.pollTool!, pollToolArg: provider.mcpOptions?.pollToolArg },
            job!.taskRef!,
            { signal: controller.signal },
          );
        } finally {
          clearTimeout(timer);
        }
        if (normalized.status === 'completed') {
          job = admin.updateVideoJob(job.id, {
            status: 'completed',
            progress: 100,
            videoUrls: pickVideoUrls(normalized),
            result: { ...(job.result ?? {}), ...normalized },
          }) ?? job;
        } else if (normalized.status === 'failed') {
          job = admin.updateVideoJob(job.id, {
            status: 'failed',
            error: normalized.text.slice(0, 300) || normalized.taskStatus || 'generation failed',
            result: { ...(job.result ?? {}), ...normalized },
          }) ?? job;
        } else {
          job = admin.updateVideoJob(job.id, {
            status: normalized.status ?? 'in_progress',
            progress: normalized.progress ?? job.progress,
            result: { ...(job.result ?? {}), ...normalized },
          }) ?? job;
        }
      } catch (err) {
        // Poll gagal (transient — rate limit/network): JANGAN gagalkan job;
        // balas status terakhir + catatan error utk klien.
        pushConsoleLog('warn', 'mcp', `video job ${job.id} poll failed: ${(err as Error).message?.slice(0, 200)}`, {
          route: job.routeId, provider: job.providerId, taskRef: job.taskRef,
        });
        return c.json({
          ...videoJobToObject(job),
          sibergate: {
            ...(videoJobToObject(job).sibergate as Record<string, unknown>),
            last_poll_error: (err as Error).message?.slice(0, 200),
          },
        });
      }
    }
  }
  return c.json(videoJobToObject(job));
}

async function videoContentHandler(c: Context, configStore: ConfigStore) {
  const id = String(c.req.param('id'));
  const job = admin.getVideoJob(id);
  if (!job) {
    return errorResponse(c, 404, `Video '${id}' not found.`, 'invalid_request_error', 'video_not_found');
  }
  const accessError = enforceVideoJobAccess(c, job);
  if (accessError) return accessError;
  if (job.status !== 'completed' || !job.videoUrls.length) {
    return errorResponse(
      c, 400,
      `Video '${id}' is not ready yet (status: ${job.status}). Poll GET /v1/videos/${id} until status='completed'.`,
      'invalid_request_error', 'video_not_ready',
    );
  }
  const url = job.videoUrls[0]!;
  // Data URI (data:video/...;base64,) → serve bytes langsung.
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUri) {
    const bytes = Buffer.from(dataUri[2]!, 'base64');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'Content-Type': dataUri[1]!, 'Content-Length': String(bytes.length) },
    });
  }
  // URL aset (pre-signed; valid 24 jam di Kling) → proxy stream bytes supaya
  // klien tidak perlu mengakses CDN upstream langsung.
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return errorResponse(c, 502, `Failed to fetch video content: ${(err as Error).message}`, 'upstream_error', 'video_fetch_failed');
  }
  if (!res.ok || !res.body) {
    return errorResponse(c, 502, `Failed to fetch video content (upstream ${res.status}). URL aset mungkin kedaluwarsa (valid 24 jam di Kling).`, 'upstream_error', 'video_fetch_failed');
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type')?.startsWith('video/') ? res.headers.get('content-type')! : 'video/mp4',
      ...(res.headers.get('content-length') ? { 'Content-Length': res.headers.get('content-length')! } : {}),
    },
  });
}

function videoDeleteHandler(c: Context, _configStore: ConfigStore) {
  const id = String(c.req.param('id'));
  const job = admin.getVideoJob(id);
  if (!job) {
    return errorResponse(c, 404, `Video '${id}' not found.`, 'invalid_request_error', 'video_not_found');
  }
  const accessError = enforceVideoJobAccess(c, job);
  if (accessError) return accessError;
  admin.deleteVideoJob(id);
  // Catatan: task upstream TIDAK bisa dibatalkan (kebijakan Kling) — ini hanya
  // menghapus job lokal + memutus pelacakan.
  return c.body(null, 204);
}

/* ─────────────────────────────────────────────────────────────────────────
 * MCP generik (modality 'mcp') — POST /v1/mcp/{route}/tools/{tool}.
 * ───────────────────────────────────────────────────────────────────────── */

/** Resolve provider MCP pertama yg usable dari route modality 'mcp'. */
function firstMcpTargetProvider(config: SiberGateConfig, route: Route) {
  for (const t of route.targets) {
    if (!t.enabled) continue;
    const provider = config.providers.find((p) => p.id === t.providerId && p.enabled && p.protocol === 'mcp');
    if (provider) return provider;
  }
  return null;
}

async function mcpListToolsHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const routeId = String(c.req.param('routeId'));
  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;
  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found');
  }
  if ((route.modality ?? 'chat') !== 'mcp') {
    return errorResponse(
      c, 400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not an mcp route.`,
      'invalid_request_error', 'modality_mismatch',
    );
  }
  const provider = firstMcpTargetProvider(config, route);
  if (!provider) {
    return errorResponse(c, 400, `Route '${routeId}' has no enabled MCP provider target.`, 'invalid_request_error', 'no_mcp_target');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const tools = await mcpToolsList(provider, { signal: controller.signal });
    return c.json({ object: 'list', data: tools });
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    return errorResponse(c, mapUpstreamErrorStatus(e), e.message ?? 'MCP tools/list failed.', 'upstream_error', e.code ?? null);
  } finally {
    clearTimeout(timer);
  }
}

async function mcpCallToolHandler(c: Context, configStore: ConfigStore) {
  const config = configStore.get();
  const requestId = c.get('requestId');
  const startedAt = c.get('startedAt');
  const passthroughHeaders = extractPassthroughHeaders(c);
  const routeId = String(c.req.param('routeId'));
  const toolName = String(c.req.param('toolName'));
  const path = `/v1/mcp/${routeId}/tools/${toolName}`;

  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;
  let route;
  try {
    route = getRoute(config, routeId);
  } catch {
    return errorResponse(c, 404, `Route '${routeId}' not found.`, 'invalid_request_error', 'model_not_found');
  }
  if ((route.modality ?? 'chat') !== 'mcp') {
    return errorResponse(
      c, 400,
      `Route '${routeId}' is a ${route.modality ?? 'chat'} route, not an mcp route.`,
      'invalid_request_error', 'modality_mismatch',
    );
  }

  const parsed = await c.req.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResponse(c, 400, 'Request body must be a JSON object (tool arguments, or {"arguments": {...}}).', 'invalid_request_error');
  }
  // Nama tool dari URL di-inject ke body — adapter mcp membacanya dari sana.
  const body = { ...(parsed as Record<string, unknown>), __mcpTool: toolName };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route.timeoutMs ?? 60_000);
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  emitIncoming(c, route.id, 'mcp');

  const baseLog = {
    requestId,
    method: 'POST',
    path,
    route: route.id,
    strategy: route.strategy,
    modality: 'mcp' as RouteModality,
    streamed: false,
    status: 200,
    latencyMs: 0,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    apiKeyId: c.get('apiKeyId') ?? null,
  };

  try {
    const { response, servedBy, latencyMs, servedByKeyId, trail } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);
    const upstreamContentType = response.headers.get('content-type') ?? 'application/json';
    const buf = Buffer.from(await response.arrayBuffer());
    const model = config.models.find((m) => m.id === servedBy.modelId);
    const successTraced = traceOnSuccess({ requestId, c, route: route.id, trail, servedBy });
    logRequest({
      ...baseLog,
      provider: servedBy.providerId,
      // Tool adalah "model" yg bermakna utk log (modelId target = placeholder).
      model: toolName,
      upstreamKeyId: servedByKeyId ?? null,
      latencyMs,
      costUsd: computeCost(model?.inputPricePer1m, model?.outputPricePer1m, 0, 0),
      metadata: successTraced ? { trail, hasTrace: true } : { trail },
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
      provider: e.servedBy?.provider ?? null, model: toolName,
      upstreamUrl: e.upstream?.url, upstreamStatus: e.upstream?.status, upstreamBody: e.upstream?.body, upstreamRequestBody: e.upstream?.requestBody, upstreamRequestHeaders: e.upstream?.requestHeaders,
      hadFailover: false,
      force: true,
    });
    logRequest({
      ...baseLog,
      status,
      latencyMs,
      provider: e.servedBy?.provider ?? null,
      model: toolName,
      upstreamKeyId: e.servedBy?.keyId ?? null,
      errorCode: e.code ?? null,
      errorMessage: (e.message ?? String(e)).slice(0, 300),
      metadata: traced ? { hasTrace: true } : undefined,
    });
    const type = e.code === 'timeout' ? 'timeout_error' : e.code === 'rate_limited' ? 'rate_limit_exceeded' : 'upstream_error';
    return errorResponse(c, status, e.message ?? 'Upstream error.', type, e.code ?? null);
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
  const passthroughHeaders = extractPassthroughHeaders(c);

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
  const routeAccessError = enforceApiRoute(c, routeId);
  if (routeAccessError) return routeAccessError;

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
    const { response, servedBy, latencyMs, servedByKeyId } = await executeRoute(config, route, body, controller.signal, passthroughHeaders);

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
      force: true,
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
