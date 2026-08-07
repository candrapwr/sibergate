/**
 * Proxy Layer admin CRUD — pools, members, provider bindings.
 * Mirror pola provider_keys (child table) + route_targets (junction).
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { ConflictError, ValidationError } from '../admin.js';
import { validateProxyUrl } from './dispatcher.js';
import type { ProxyPool, ProxyPoolMember, ProxyStrategy, ProviderProxyBinding } from './types.js';

const VALID_STRATEGIES: ProxyStrategy[] = ['weighted', 'round-robin', 'failover'];

function assertValidPoolId(id: string): void {
  if (!id || !id.trim()) throw new ValidationError('Pool id must not be empty.');
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    throw new ValidationError("Pool id must be letters, digits, hyphens, or underscores.");
  }
}

/* ───────────────────────────── Pools ───────────────────────────── */

export interface ProxyPoolInput {
  id?: string;
  name?: string;
  strategy?: ProxyStrategy;
  enabled?: boolean;
}

interface PoolRow {
  id: string;
  name: string;
  strategy: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toPool(row: PoolRow): ProxyPool {
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy as ProxyStrategy,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProxyPool(input: ProxyPoolInput): ProxyPool {
  assertValidPoolId(input.id ?? '');
  const strategy = input.strategy && VALID_STRATEGIES.includes(input.strategy) ? input.strategy : 'weighted';
  try {
    getDb()
      .prepare(
        `INSERT INTO proxy_pools (id, name, strategy, enabled) VALUES (@id, @name, @strategy, @enabled)`,
      )
      .run({
        id: input.id,
        name: input.name?.trim() || input.id!,
        strategy,
        enabled: input.enabled === false ? 0 : 1,
      });
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE')) {
      throw new ValidationError(`Proxy pool '${input.id}' already exists.`);
    }
    throw err;
  }
  return getProxyPool(input.id!)!;
}

export function updateProxyPool(id: string, input: Partial<ProxyPoolInput>): ProxyPool | null {
  const existing = getProxyPool(id);
  if (!existing) return null;
  const merged: ProxyPoolInput = { id, name: existing.name, strategy: existing.strategy, enabled: existing.enabled, ...input };
  const strategy = merged.strategy && VALID_STRATEGIES.includes(merged.strategy) ? merged.strategy : 'weighted';
  getDb()
    .prepare(
      `UPDATE proxy_pools SET name = @name, strategy = @strategy, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`,
    )
    .run({
      id,
      name: merged.name?.trim() || id,
      strategy,
      enabled: merged.enabled === false ? 0 : 1,
    });
  return getProxyPool(id);
}

export function getProxyPool(id: string): ProxyPool | null {
  const row = getDb().prepare('SELECT * FROM proxy_pools WHERE id = ?').get(id) as PoolRow | undefined;
  return row ? toPool(row) : null;
}

export function listProxyPools(): Array<ProxyPool & { memberCount: number; healthyCount: number; boundProviderCount: number }> {
  const db = getDb();
  return (db.prepare('SELECT * FROM proxy_pools ORDER BY created_at ASC').all() as PoolRow[]).map((row) => {
    const pool = toPool(row);
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN enabled = 1 AND healthy = 1 THEN 1 ELSE 0 END) as healthy
         FROM proxy_pool_members WHERE pool_id = ?`,
      )
      .get(row.id) as { total: number; healthy: number };
    const bound = db
      .prepare('SELECT COUNT(*) as c FROM provider_proxy_pools WHERE pool_id = ? AND enabled = 1')
      .get(row.id) as { c: number };
    return {
      ...pool,
      memberCount: counts.total ?? 0,
      healthyCount: counts.healthy ?? 0,
      boundProviderCount: bound.c ?? 0,
    };
  });
}

export function deleteProxyPool(id: string): boolean {
  // FK CASCADE: members + bindings ikut terhapus.
  const res = getDb().prepare('DELETE FROM proxy_pools WHERE id = ?').run(id);
  return res.changes > 0;
}

/* ──────────────────────────── Members ──────────────────────────── */

export interface PoolMemberInput {
  proxyUrl: string;
  label?: string;
  weight?: number;
  enabled?: boolean;
}

interface MemberRow {
  id: number;
  pool_id: string;
  proxy_url: string;
  label: string | null;
  weight: number;
  enabled: number;
  healthy: number;
  country: string | null;
  exit_ip: string | null;
  last_check_at: string | null;
  created_at: string;
}

function toMember(row: MemberRow): ProxyPoolMember {
  return {
    id: row.id,
    poolId: row.pool_id,
    proxyUrl: row.proxy_url,
    label: row.label,
    weight: row.weight,
    enabled: row.enabled === 1,
    healthy: row.healthy === 1,
    country: row.country,
    exitIp: row.exit_ip,
    lastCheckAt: row.last_check_at,
    createdAt: row.created_at,
  };
}

export function listPoolMembers(poolId: string): ProxyPoolMember[] {
  return (getDb()
    .prepare('SELECT * FROM proxy_pool_members WHERE pool_id = ? ORDER BY id ASC')
    .all(poolId) as MemberRow[]).map(toMember);
}

export function addPoolMember(poolId: string, input: PoolMemberInput): ProxyPoolMember {
  if (!getProxyPool(poolId)) throw new ValidationError(`Proxy pool '${poolId}' not found.`);
  const validated = validateProxyUrl(input.proxyUrl);
  if (!validated) {
    throw new ValidationError('Invalid proxy URL (must be http/https/socks5/socks4 with host).');
  }
  const result = getDb()
    .prepare(
      `INSERT INTO proxy_pool_members (pool_id, proxy_url, label, weight, enabled, healthy)
       VALUES (@poolId, @proxyUrl, @label, @weight, @enabled, 1)`,
    )
    .run({
      poolId,
      proxyUrl: validated,
      label: input.label ?? null,
      weight: Math.max(1, input.weight ?? 1),
      enabled: input.enabled === false ? 0 : 1,
    });
  const id = Number(result.lastInsertRowid);
  return getPoolMember(id)!;
}

export function getPoolMember(memberId: number): ProxyPoolMember | null {
  const row = getDb().prepare('SELECT * FROM proxy_pool_members WHERE id = ?').get(memberId) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

export function updatePoolMember(memberId: number, input: Partial<PoolMemberInput>): ProxyPoolMember | null {
  const existing = getPoolMember(memberId);
  if (!existing) return null;
  const proxyUrl = input.proxyUrl ? validateProxyUrl(input.proxyUrl) ?? existing.proxyUrl : existing.proxyUrl;
  getDb()
    .prepare(
      `UPDATE proxy_pool_members SET proxy_url = @proxyUrl, label = @label, weight = @weight, enabled = @enabled WHERE id = @id`,
    )
    .run({
      id: memberId,
      proxyUrl,
      label: input.label !== undefined ? input.label : existing.label,
      weight: input.weight !== undefined ? Math.max(1, input.weight) : existing.weight,
      enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
    });
  return getPoolMember(memberId);
}

export function deletePoolMember(memberId: number): boolean {
  const res = getDb().prepare('DELETE FROM proxy_pool_members WHERE id = ?').run(memberId);
  return res.changes > 0;
}

/* ──────────────────────── Provider bindings ────────────────────── */

export function listPoolBindings(poolId: string): ProviderProxyBinding[] {
  return (getDb()
    .prepare('SELECT * FROM provider_proxy_pools WHERE pool_id = ? ORDER BY provider_id')
    .all(poolId) as Array<{ provider_id: string; pool_id: string; enabled: number }>).map((r) => ({
    providerId: r.provider_id,
    poolId: r.pool_id,
    enabled: r.enabled === 1,
  }));
}

/** Bind provider ke pool. Idempoten (re-bind = update enabled). */
export function bindProviderToPool(providerId: string, poolId: string, enabled = true): void {
  if (!getProxyPool(poolId)) throw new ValidationError(`Proxy pool '${poolId}' not found.`);
  getDb()
    .prepare(
      `INSERT INTO provider_proxy_pools (provider_id, pool_id, enabled) VALUES (@providerId, @poolId, @enabled)
       ON CONFLICT(provider_id, pool_id) DO UPDATE SET enabled = @enabled`,
    )
    .run({ providerId, poolId, enabled: enabled ? 1 : 0 });
}

export function unbindProviderFromPool(providerId: string, poolId: string): void {
  getDb()
    .prepare('DELETE FROM provider_proxy_pools WHERE provider_id = ? AND pool_id = ?')
    .run(providerId, poolId);
}

/** Ambil pool id + enabled state yg aktif utk provider (utk runtime selector). */
export function getActivePoolForProvider(providerId: string): { poolId: string } | null {
  const row = getDb()
    .prepare(
      `SELECT pp.pool_id as pool_id
       FROM provider_proxy_pools pp
       JOIN proxy_pools p ON p.id = pp.pool_id
       WHERE pp.provider_id = ? AND pp.enabled = 1 AND p.enabled = 1
       LIMIT 1`,
    )
    .get(providerId) as { pool_id: string } | undefined;
  return row ? { poolId: row.pool_id } : null;
}
