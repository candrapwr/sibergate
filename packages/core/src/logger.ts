import { getDb } from './db.js';
import { pushConsoleLog, type ConsoleLogLevel } from './console-log.js';

/**
 * Request logger (writes to the shared SQLite `requests` table).
 * Fire-and-forget: never throws into the request path.
 */
export interface LogRequest {
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  strategy?: string | null;
  modality?: string | null;
  streamed?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  clientIp?: string | null;
  /** ID API key yg meng-autentikasi request ini (utk statistik per-key). Null bila auth-open. */
  apiKeyId?: string | null;
  /** ID upstream key (provider_keys.id) yg melayani request ini (multi-account). Null = default key. */
  upstreamKeyId?: string | null;
  /** True bila request ini sempat gagal di ≥1 target lalu recovered via failover (status final 200). */
  hadFailover?: boolean;
  /** JSON-serializable metadata (e.g. failover trail). */
  metadata?: Record<string, unknown>;
}

const insertStmt = `
  INSERT INTO requests
    (request_id, method, path, status, latency_ms, route, provider, model, strategy,
     streamed, prompt_tokens, completion_tokens, total_tokens, cost_usd, error_code,
     error_message, client_ip, api_key_id, upstream_key_id, metadata, had_failover)
  VALUES (@requestId, @method, @path, @status, @latencyMs, @route, @provider, @model,
          @strategy, @streamed, @promptTokens, @completionTokens, @totalTokens, @costUsd,
          @errorCode, @errorMessage, @clientIp, @apiKeyId, @upstreamKeyId, @metadata, @hadFailover)
`;

export function logRequest(entry: LogRequest): void {
  // Auto-detect failover from metadata.trail bila caller tidak set explicit:
  // request recovered (final 200) tapi sempat gagal di ≥1 target. Ini supaya
  // upstream-error yg terkubur di trail tetap terlihat di Logs/stats tanpa
  // harus ubah setiap call site secara manual.
  let hadFailover = entry.hadFailover;
  if (hadFailover === undefined && Array.isArray(entry.metadata?.trail)) {
    hadFailover = (entry.metadata!.trail as Array<{ outcome?: string }>).some(
      (s) => s.outcome === 'failed',
    );
  }
  try {
    getDb()
      .prepare(insertStmt)
      .run({
        requestId: entry.requestId,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        latencyMs: entry.latencyMs,
        route: entry.route ?? null,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        strategy: entry.strategy ?? null,
        streamed: entry.streamed ? 1 : 0,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
        totalTokens: entry.totalTokens ?? 0,
        costUsd: entry.costUsd ?? 0,
        errorCode: entry.errorCode ?? null,
        errorMessage: entry.errorMessage ?? null,
        clientIp: entry.clientIp ?? null,
        apiKeyId: entry.apiKeyId ?? null,
        upstreamKeyId: entry.upstreamKeyId ?? null,
        metadata: JSON.stringify(entry.metadata ?? {}),
        hadFailover: hadFailover ? 1 : 0,
      });
  } catch (err) {
    console.error('[sibergate] failed to write log:', (err as Error).message);
  }

  // Mirror to the live console bus. Single hook covers every call site
  // (all 14 logRequest() invocations across the gateway route handlers).
  try {
    const status = entry.status;
    const level: ConsoleLogLevel =
      status >= 500 ? 'error' : status >= 400 ? 'warn' : 'success';
    const target = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : null;
    const parts = [
      `${entry.method} ${entry.path}`,
      `→ ${status}`,
      `${entry.latencyMs}ms`,
      entry.route ? `[${entry.route}]` : null,
      target ? `· ${target}` : null,
    ].filter(Boolean);
    pushConsoleLog(level, 'request', parts.join(' '), {
      requestId: entry.requestId,
      method: entry.method,
      path: entry.path,
      status,
      latencyMs: entry.latencyMs,
      route: entry.route ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      strategy: entry.strategy ?? null,
      streamed: entry.streamed ?? false,
      modality: entry.modality ?? null,
      totalTokens: entry.totalTokens ?? 0,
      costUsd: entry.costUsd ?? 0,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      clientIp: entry.clientIp ?? null,
    });
  } catch {
    /* swallow — console mirror must never break the request */
  }
}

/** Update an api key's last_used_at (fire-and-forget). */
export function touchApiKey(keyId: string): void {
  try {
    getDb()
      .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
      .run(keyId);
  } catch {
    /* ignore */
  }
}
