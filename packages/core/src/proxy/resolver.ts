/**
 * Runtime resolver — satu-satunya contract yg dipanggil engine.
 *
 * resolveProxy(providerId) → ResolvedProxy | null
 *   1. Cek provider ini bind ke pool aktif? (getActivePoolForProvider)
 *   2. Load members pool, select member (strategi + health)
 *   3. Return { poolId, memberId, proxyUrl } utk dispatch
 *
 * Dipanggil per-target di engine loop. Selector + health state cached in-memory.
 */
import { getActivePoolForProvider, listPoolMembers, getProxyPool } from './admin.js';
import { selectMember } from './selector.js';
import type { ResolvedProxy } from './types.js';

/** Resolve proxy utk provider. Null = direct fetch (tidak ada binding/pool/member eligible). */
export function resolveProxy(providerId: string): ResolvedProxy | null {
  const active = getActivePoolForProvider(providerId);
  if (!active) return null; // provider tidak bind ke pool manapun
  const pool = getProxyPool(active.poolId);
  if (!pool || !pool.enabled) return null;
  const members = listPoolMembers(active.poolId);
  const member = selectMember(active.poolId, pool.strategy, members);
  if (!member) return null; // tidak ada member enabled+healthy → direct fallback
  return {
    poolId: active.poolId,
    memberId: member.id,
    proxyUrl: member.proxyUrl,
    country: member.country,
  };
}
