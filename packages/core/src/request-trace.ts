import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Raw request trace storage — per-request `.json` files written to disk whenever
 * an upstream error occurs (including failover-recovered ones). Kept OUT of the
 * SQLite DB on purpose: raw request bodies (messages, tools, headers) can be
 * large, and storing them per-request would bloat the DB. One file per request
 * keeps the DB lean and is cheap to purge on log clear.
 *
 * Files live at `<cwd>/request_traces/<requestId>.json` (override via
 * `SIBERGATE_TRACE_DIR`). File mode 0o600 mirrors the master-key/backup idiom.
 * Filename = requestId (UUID) — filesystem-safe and unique.
 *
 * Purge lifecycle: clearLogs / resetStats / clearAllData wipe the whole dir so
 * traces never outlive their corresponding DB log rows.
 */

/** The full payload persisted to disk for one request. */
export interface RequestTraceData {
  requestId: string;
  ts: string;
  client: {
    method: string;
    path: string;
    query?: string;
    ip?: string | null;
    /** Headers with secrets redacted (Authorization, x-api-key, …). */
    headers: Record<string, string>;
  };
  /** The original client request body (messages, tools, model, …). */
  body?: unknown;
  /** The failing upstream call, when available (absent on timeout/network). */
  upstream?: {
    url?: string;
    status?: number;
    responseBody?: string | null;
  };
  /** Route context for quick identification when browsing files. */
  route?: string | null;
  provider?: string | null;
  model?: string | null;
}

/** Resolve the trace directory, creating it if missing. */
function traceDir(): string {
  const dir = resolve(process.cwd(), process.env.SIBERGATE_TRACE_DIR ?? 'request_traces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Safe filename from a requestId (UUID — already fs-safe, but guard anyway). */
function traceFile(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolve(traceDir(), `${safe}.json`);
}

/**
 * Persist a raw request trace. Fire-and-forget: swallows all errors so it can
 * never break the request path (mirrors the logRequest contract).
 */
export function saveRequestTrace(data: RequestTraceData): void {
  try {
    writeFileSync(traceFile(data.requestId), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[sibergate] failed to write request trace:', (err as Error).message);
  }
}

/** Read a trace by requestId. Returns null if the file doesn't exist. */
export function readRequestTrace(requestId: string): RequestTraceData | null {
  try {
    const raw = readFileSync(traceFile(requestId), 'utf8');
    return JSON.parse(raw) as RequestTraceData;
  } catch {
    return null;
  }
}

/**
 * Delete every trace file (used by clearLogs / resetStats / full wipe).
 * Removes the directory and recreates it empty, keeping the path stable.
 */
export function clearRequestTraces(): { removed: number } {
  try {
    const dir = resolve(process.cwd(), process.env.SIBERGATE_TRACE_DIR ?? 'request_traces');
    let count = 0;
    try {
      count = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    } catch {
      /* dir doesn't exist yet */
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return { removed: count };
  } catch (err) {
    console.error('[sibergate] failed to clear request traces:', (err as Error).message);
    return { removed: 0 };
  }
}
