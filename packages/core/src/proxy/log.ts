/**
 * Proxy event log — tulis ke proxy_logs table + emit ke console bus (live stream).
 * Fire-and-forget (try/catch swallow, logging tidak boleh ganggu request path).
 */
import { getDb } from '../db.js';
import { pushConsoleLog } from '../console-log.js';
import type { ProxyLogEntry, ProxyOutcome } from './types.js';

export interface ProxyLogInput {
  poolId: string | null;
  memberId: number | null;
  memberUrl: string | null;
  providerId: string | null;
  outcome: ProxyOutcome;
  latencyMs: number | null;
  country: string | null;
  error?: string | null;
  details?: Record<string, unknown> | null;
}

/** Tulis satu baris proxy_logs + emit console event (kategori 'proxy'). */
export function pushProxyLog(input: ProxyLogInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO proxy_logs (pool_id, member_id, member_url, provider_id, outcome, latency_ms, country, error, details)
         VALUES (@poolId, @memberId, @memberUrl, @providerId, @outcome, @latencyMs, @country, @error, @details)`,
      )
      .run({
        poolId: input.poolId,
        memberId: input.memberId,
        memberUrl: input.memberUrl,
        providerId: input.providerId,
        outcome: input.outcome,
        latencyMs: input.latencyMs,
        country: input.country,
        error: input.error ?? null,
        details: input.details ? JSON.stringify(input.details) : null,
      });
  } catch {
    /* swallow */
  }
  // Emit ke console live stream dgn flag proxy 🌐.
  try {
    const level = input.outcome === 'served' || input.outcome === 'recovered' ? 'info' : input.outcome === 'selected' ? 'info' : 'warn';
    const flag = input.country ? ` ${input.country}` : '';
    pushConsoleLog(
      level as 'info' | 'warn',
      'proxy',
      `🌐 proxy ${input.outcome}${flag} (${input.latencyMs ?? '?'}ms)`,
      {
        poolId: input.poolId,
        memberId: input.memberId,
        providerId: input.providerId,
        outcome: input.outcome,
        latencyMs: input.latencyMs,
        country: input.country,
        error: input.error,
      },
    );
  } catch {
    /* swallow */
  }
}

/** Ambil proxy_logs terbaru (utk UI), dgn mapping snake_case → camelCase. */
export function recentProxyLogs(limit = 100): ProxyLogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM proxy_logs ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{
      id: number; ts: string; pool_id: string | null; member_id: number | null;
      member_url: string | null; provider_id: string | null; outcome: string;
      latency_ms: number | null; country: string | null; error: string | null; details: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    poolId: r.pool_id,
    memberId: r.member_id,
    memberUrl: r.member_url,
    providerId: r.provider_id,
    outcome: r.outcome as ProxyOutcome,
    latencyMs: r.latency_ms,
    country: r.country,
    error: r.error,
    details: r.details,
  }));
}

/** Hapus semua proxy_logs (clear logs maintenance). */
export function clearProxyLogs(): void {
  getDb().prepare('DELETE FROM proxy_logs').run();
}
