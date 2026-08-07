/**
 * Runtime resolver — satu-satunya contract yg dipanggil engine.
 *
 * resolveProxy(providerId) → ResolvedProxy | null
 *   1. Cek provider ini bind ke pool aktif? (getActivePoolForProvider)
 *   2. Load members pool, select member (strategi + health)
 *   3. Return ResolvedProxy (poolId, memberId, proxyUrl, type, edge info) utk
 *      buildTransport() memutuskan: dispatcher (http/socks) atau relay (edge).
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
  // Untuk edge-relay, proxyUrl = relay_url (worker URL). Bila belum di-deploy
  // (relayUrl null), anggap tidak eligible (selector sudah filter healthy, tapi
  // double-guard: edge member tanpa relay URL = skip).
  if (member.type === 'edge-relay' && !member.relayUrl) return null;
  return {
    poolId: active.poolId,
    memberId: member.id,
    proxyUrl: member.type === 'edge-relay' ? member.relayUrl ?? '' : member.proxyUrl,
    country: member.country,
    type: member.type,
    edgeProvider: member.edgeProvider,
    edgeMemberId: member.type === 'edge-relay' ? member.id : null,
  };
}
