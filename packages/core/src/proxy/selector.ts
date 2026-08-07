/**
 * Member selection — pilih 1 member dari pool berdasarkan strategi + health.
 * Hanya member enabled + healthy yg dipertimbangkan. Round-robin state in-memory
 * per pool (reset saat restart, idempoten utk single-process).
 */
import type { ProxyPoolMember, ProxyStrategy } from './types.js';

/** State round-robin per pool (poolId → next index). */
const rrState = new Map<string, number>();

/** Ambil member yg eligible (enabled + healthy). */
function eligible(members: ProxyPoolMember[]): ProxyPoolMember[] {
  return members.filter((m) => m.enabled && m.healthy);
}

/** Weighted random pick. */
function pickWeighted(members: ProxyPoolMember[]): ProxyPoolMember | null {
  const total = members.reduce((s, m) => s + Math.max(1, m.weight), 0);
  let r = Math.random() * total;
  for (const m of members) {
    r -= Math.max(1, m.weight);
    if (r <= 0) return m;
  }
  return members[members.length - 1] ?? null;
}

/** Round-robin (cycle berurutan, in-memory). */
function pickRoundRobin(poolId: string, members: ProxyPoolMember[]): ProxyPoolMember | null {
  if (members.length === 0) return null;
  const idx = (rrState.get(poolId) ?? 0) % members.length;
  rrState.set(poolId, (idx + 1) % members.length);
  return members[idx]!;
}

/** Failover: ambil pertama (urutan = insertion order by id). */
function pickFailover(members: ProxyPoolMember[]): ProxyPoolMember | null {
  return [...members].sort((a, b) => a.id - b.id)[0] ?? null;
}

/**
 * Pilih member berdasarkan strategi pool. Return null bila tidak ada eligible.
 * Members harus sudah di-load dari DB (caller urus). Sort failover by id.
 */
export function selectMember(
  poolId: string,
  strategy: ProxyStrategy,
  members: ProxyPoolMember[],
): ProxyPoolMember | null {
  const elig = eligible(members);
  if (elig.length === 0) return null;
  switch (strategy) {
    case 'round-robin':
      return pickRoundRobin(poolId, elig);
    case 'failover':
      return pickFailover(elig);
    case 'weighted':
    default:
      return pickWeighted(elig);
  }
}

/** Reset state round-robin (utk reload/test). */
export function resetSelectionState(): void {
  rrState.clear();
}
