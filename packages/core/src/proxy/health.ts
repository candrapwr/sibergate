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
import { getEdgeProvider } from './edge/index.js';
import { lookupCountry } from './geoip.js';
import { getDb } from '../db.js';
import { pushProxyLog } from './log.js';
import type { ProxyTestResult } from './types.js';

// Connectivity check (apakah proxy bisa keluar internet?) — pakai example.com,
// host paling reliable (dikelola IANA, always up, tidak pernah 503/load-balanced).
const CONNECTIVITY_URL = process.env.SIBERGATE_PROXY_CHECK_URL ?? 'https://example.com';
// Exit IP check (untuk geoip flag) — pakai ipify (return IP plain text, stabil).
// Override lewat env SIBERGATE_PROXY_IP_URL; set '' utk skip exit IP detection.
const EXIT_IP_URL = process.env.SIBERGATE_PROXY_IP_URL ?? 'https://api.ipify.org';
const CHECK_TIMEOUT_MS = Number(process.env.SIBERGATE_PROXY_CHECK_TIMEOUT_MS ?? 8000);

/**
 * Ekstrak IP keluar dari response. Mendukung plain text (ipify), JSON
 * {origin|ip|query} (httpbin/ip.sb), atau string mentah IPv4/IPv6.
 */
function extractIp(body: string): string | null {
  const trimmed = body.trim();
  // Plain IPv4/IPv6 (ipify default).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed) || /^[0-9a-f:]+$/i.test(trimmed)) {
    return trimmed;
  }
  // JSON variant.
  try {
    const j = JSON.parse(trimmed) as { origin?: string; ip?: string; query?: string };
    return j.origin ?? j.ip ?? j.query ?? null;
  } catch {
    return null;
  }
}

/**
 * Test satu proxy URL. Dua tahap:
 *   1. Connectivity: GET example.com (reliable) → pastikan proxy bisa keluar internet.
 *   2. Exit IP: GET ipify → capture IP keluar → lookup negara/flag (geoip).
 *
 * Tahap 2 fail tidak membatalkan test — proxy tetap OK (connectivity lulus),
 * hanya flag negara tampil 🏳️. Fail-open di tiap tahap.
 */
export async function testProxy(proxyUrl: string): Promise<ProxyTestResult> {
  const start = Date.now();
  let dispatcher;
  try {
    dispatcher = buildDispatcher(proxyUrl);
  } catch (err) {
    return { ok: false, latencyMs: 0, exitIp: null, geo: null, error: (err as Error).message };
  }

  // Tahap 1: connectivity (example.com).
  const ctrl1 = new AbortController();
  const timer1 = setTimeout(() => ctrl1.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(CONNECTIVITY_URL, { signal: ctrl1.signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, exitIp: null, geo: null, error: `connectivity HTTP ${res.status}` };
    }
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      latencyMs: Date.now() - start,
      exitIp: null,
      geo: null,
      error: e.name === 'AbortError' ? `timeout (${CHECK_TIMEOUT_MS}ms)` : e.message,
    };
  } finally {
    clearTimeout(timer1);
  }

  const latencyMs = Date.now() - start;

  // Tahap 2: exit IP (ipify) utk geoip. Fail-open: skip flag bila gagal.
  let exitIp: string | null = null;
  if (EXIT_IP_URL) {
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), CHECK_TIMEOUT_MS);
    try {
      const ipRes = await fetch(EXIT_IP_URL, { signal: ctrl2.signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      if (ipRes.ok) {
        exitIp = extractIp(await ipRes.text());
      }
    } catch {
      /* fail-open: no exit IP, no flag */
    } finally {
      clearTimeout(timer2);
    }
  }

  const geo = exitIp ? lookupCountry(exitIp) : null;
  return { ok: true, latencyMs, exitIp, geo };
}

/**
 * Test satu member (cabang by type). Edge-relay pakai provider.testConnectivity
 * (GET relay/__health). http/socks pakai testProxy (example.com + ipify).
 */
export async function testMember(
  member: { type: string; proxyUrl: string; relayUrl: string | null; edgeProvider: string | null },
): Promise<ProxyTestResult> {
  if (member.type === 'edge-relay' && member.edgeProvider && member.relayUrl) {
    const provider = getEdgeProvider(member.edgeProvider);
    const r = await provider.testConnectivity(member.relayUrl);
    return {
      ok: r.ok,
      latencyMs: r.latencyMs,
      exitIp: null, // edge relay tidak expose exit IP (worker __health return ok saja)
      geo: null,
      error: r.error,
    };
  }
  // http-proxy / socks5.
  return testProxy(member.proxyUrl);
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
