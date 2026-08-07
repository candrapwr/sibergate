/**
 * buildTransport — centralized decision: resolved proxy → {dispatcher? | relay?}.
 *
 * Dipanggil engine.ts + gateway routes.ts async-poll (2 call site) supaya
 * branching edge-relay vs http/socks tidak divergen. Bila resolved adalah
 * edge-relay, decrypt edge_config + build EdgeRelayRuntime (worker URL +
 * injectHeaders). Bila http/socks, build ProxyAgent dispatcher.
 *
 * providerOrigin = origin provider tujuan (mis. https://api.openai.com). Dipakai
 * edge relay utk isi x-relay-target header. Bila undefined (engine belum resolve
 * provider), relay build pakai placeholder — caller harus pass origin utk edge.
 */
import { buildDispatcher } from './dispatcher.js';
import { getEdgeProvider } from './edge/index.js';
import { getMemberEdgeConfig } from './admin.js';
import type { ResolvedProxy } from './types.js';
import type { EdgeRelayRuntime } from './edge/index.js';

export interface Transport {
  /** Untuk http-proxy/socks5: undici dispatcher. */
  dispatcher?: unknown;
  /** Untuk edge-relay: worker URL + headers utk rewrite. */
  relay?: EdgeRelayRuntime;
  /** Info utk logging (pool/member/country). */
  poolId: string;
  memberId: number;
  country: string | null;
  type: string;
}

export function buildTransport(resolved: ResolvedProxy, providerBaseUrl: string): Transport {
  const base = { poolId: resolved.poolId, memberId: resolved.memberId, country: resolved.country, type: resolved.type };
  if (resolved.type === 'edge-relay' && resolved.edgeProvider && resolved.edgeMemberId != null) {
    const provider = getEdgeProvider(resolved.edgeProvider);
    // Decrypt config transient (never logged).
    const config = getMemberEdgeConfig(resolved.edgeMemberId) ?? {};
    // CRITICAL: x-relay-target harus ORIGIN saja (protocol://host), BUKAN full
    // baseUrl (mis. .../v1). Adapter URL = baseUrl + path (mis. .../v1/chat). Worker
    // baca header ini + gabung dgn request pathname → kalau target include /v1, path
    // jadi dobel (.../v1/v1/chat). Pakai origin-only = Worker gabung origin + path
    // lengkap dari request = .../v1/chat (benar).
    let origin = providerBaseUrl;
    try {
      const u = new URL(providerBaseUrl);
      origin = `${u.protocol}//${u.host}`;
    } catch {
      /* fallback: pakai apa adanya */
    }
    const relay = provider.buildRelayConfig(config, origin);
    return { ...base, relay };
  }
  // http-proxy / socks5.
  const dispatcher = buildDispatcher(resolved.proxyUrl);
  return { ...base, dispatcher };
}
