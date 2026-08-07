/**
 * Proxy health-check + test.
 *
 * - testProxy(): satu-shot test utk tombol Test di UI. Hit endpoint netral,
 *   ukur latensi, capture exit IP + lookup geoip. Tidak mengandalkan DB.
 * - markMemberUnhealthy/healthy(): update state DB (passive on-fail).
 * - startHealthMonitor(): background ping periodik utk semua member aktif.
 *
 * Endpoint test default httpbin.org/ip (netral, return IP kita). Override via
 * SIBERGATE_PROXY_CHECK_URL. Timeout default 5s.
 */
import { buildDispatcher } from './dispatcher.js';
import { lookupCountry } from './geoip.js';
import { getDb } from '../db.js';
import { pushProxyLog } from './log.js';
import type { ProxyTestResult } from './types.js';

const CHECK_URL = process.env.SIBERGATE_PROXY_CHECK_URL ?? 'https://httpbin.org/ip';
const CHECK_TIMEOUT_MS = Number(process.env.SIBERGATE_PROXY_CHECK_TIMEOUT_MS ?? 5000);

interface IpResponse {
  origin?: string;
  ip?: string;
}

/** Ekstrak IP dari response endpoint netral. */
function extractIp(json: IpResponse | null): string | null {
  return json?.origin ?? json?.ip ?? null;
}

/** Test satu proxy URL. Return latensi + exit IP + geoip. Tidak sentuh DB. */
export async function testProxy(proxyUrl: string): Promise<ProxyTestResult> {
  const start = Date.now();
  let dispatcher;
  try {
    dispatcher = buildDispatcher(proxyUrl);
  } catch (err) {
    return { ok: false, latencyMs: 0, exitIp: null, geo: null, error: (err as Error).message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    // `dispatcher` is undici-specific (not in DOM RequestInit type); cast.
    const res = await fetch(CHECK_URL, { signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, exitIp: null, geo: null, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as IpResponse | null;
    const exitIp = extractIp(json);
    const geo = exitIp ? lookupCountry(exitIp) : null;
    return { ok: true, latencyMs, exitIp, geo };
  } catch (err) {
    const e = err as Error;
    const latencyMs = Date.now() - start;
    const aborted = e.name === 'AbortError';
    return {
      ok: false,
      latencyMs,
      exitIp: null,
      geo: null,
      error: aborted ? `timeout (${CHECK_TIMEOUT_MS}ms)` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Update health state member di DB + cache geoip hasil test. */
export function updateMemberHealth(
  memberId: number,
  result: { ok: boolean; exitIp?: string | null; geo?: { country: string } | null; error?: string },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE proxy_pool_members
     SET healthy = @healthy, exit_ip = @exitIp, country = @country,
         last_check_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: memberId,
    healthy: result.ok ? 1 : 0,
    exitIp: result.exitIp ?? null,
    country: result.geo?.country ?? null,
  });
}

/** Tandai unhealthy (passive on-fail saat request real gagal). */
export function markMemberUnhealthy(memberId: number, error: string, poolId?: string, providerId?: string): void {
  const db = getDb();
  const row = db.prepare('SELECT pool_id, proxy_url, label FROM proxy_pool_members WHERE id = ?').get(memberId) as
    | { pool_id: string; proxy_url: string; label: string | null }
    | undefined;
  if (!row) return;
  db.prepare(
    `UPDATE proxy_pool_members SET healthy = 0, last_check_at = datetime('now') WHERE id = ?`,
  ).run(memberId);
  pushProxyLog({
    poolId: poolId ?? row.pool_id,
    memberId,
    memberUrl: redactProxyUrl(row.proxy_url),
    providerId: providerId ?? null,
    outcome: 'unhealthy',
    latencyMs: null,
    country: null,
    error: error.slice(0, 300),
  });
}

/** Background health monitor — ping semua member aktif setiap interval. */
let monitorTimer: NodeJS.Timeout | null = null;

export function startHealthMonitor(intervalMs?: number): void {
  const interval = intervalMs ?? Number(process.env.SIBERGATE_PROXY_HEALTH_INTERVAL_MS ?? 60_000);
  if (monitorTimer) return; // already running
  monitorTimer = setInterval(() => {
    void pingAllMembers().catch(() => {
      /* fire-and-forget */
    });
  }, interval);
  // Don't keep process alive krn monitor (Hono server keep alive sendiri).
  monitorTimer.unref();
}

export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/** Ping semua enabled member, update health + cache geoip. */
async function pingAllMembers(): Promise<void> {
  const db = getDb();
  const members = db
    .prepare('SELECT id, proxy_url, pool_id FROM proxy_pool_members WHERE enabled = 1')
    .all() as Array<{ id: number; proxy_url: string; pool_id: string }>;
  for (const m of members) {
    const result = await testProxy(m.proxy_url);
    const was = db.prepare('SELECT healthy FROM proxy_pool_members WHERE id = ?').get(m.id) as { healthy: number } | undefined;
    updateMemberHealth(m.id, result);
    // Log recovery bila sebelumnya unhealthy & sekarang healthy.
    if (result.ok && was && was.healthy === 0) {
      pushProxyLog({
        poolId: m.pool_id,
        memberId: m.id,
        memberUrl: redactProxyUrl(m.proxy_url),
        providerId: null,
        outcome: 'recovered',
        latencyMs: result.latencyMs,
        country: result.geo?.country ?? null,
      });
    }
  }
}

/** Redact credentials di proxy URL utk log (http://user:pass@host → http://***@host). */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      // Rebuild dgn placeholder di userinfo
      return `${parsed.protocol}//***@${parsed.host}${parsed.pathname}`;
    }
    return parsed.href;
  } catch {
    return '***';
  }
}
