import { getDb } from './db.js';

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
  /** JSON-serializable metadata (e.g. failover trail). */
  metadata?: Record<string, unknown>;
}

const insertStmt = `
  INSERT INTO requests
    (request_id, method, path, status, latency_ms, route, provider, model, strategy,
     streamed, prompt_tokens, completion_tokens, total_tokens, cost_usd, error_code,
     error_message, client_ip, metadata)
  VALUES (@requestId, @method, @path, @status, @latencyMs, @route, @provider, @model,
          @strategy, @streamed, @promptTokens, @completionTokens, @totalTokens, @costUsd,
          @errorCode, @errorMessage, @clientIp, @metadata)
`;

export function logRequest(entry: LogRequest): void {
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
        metadata: JSON.stringify(entry.metadata ?? {}),
      });
  } catch (err) {
    console.error('[sibergate] failed to write log:', (err as Error).message);
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
