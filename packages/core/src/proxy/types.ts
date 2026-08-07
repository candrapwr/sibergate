/**
 * Proxy Layer runtime types — outbound proxy pools selektif per provider.
 *
 * Modul ini terisolasi dari engine. Engine hanya butuh `selectProxy(providerId)`
 * yg return member + dispatcher (atau null = direct). Detail pool/member/health
 * di-handle di sini. Lihat proxy/index.ts utk contract yg dipakai engine.
 */

/** Strategi pemilihan member dalam pool. */
export type ProxyStrategy = 'weighted' | 'round-robin' | 'failover';

/** Sebuah pool berisi beberapa member proxy. */
export interface ProxyPool {
  id: string;
  name: string;
  strategy: ProxyStrategy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Tipe member proxy. http-proxy/socks5 = tunnel (ProxyAgent), edge-relay = URL rewrite. */
export type MemberType = 'http-proxy' | 'socks5' | 'edge-relay';

/** Anggota pool (satu proxy URL + weight + health state). */
export interface ProxyPoolMember {
  id: number;
  poolId: string;
  /** Untuk http-proxy/socks5: full proxy URL. Untuk edge-relay: relay (worker) URL setelah deploy. */
  proxyUrl: string;
  label: string | null;
  weight: number;
  enabled: boolean;
  healthy: boolean;
  /** Hasil geoip (cached setelah test/health-check). */
  country: string | null;
  /** IP keluar terdeteksi (cached). */
  exitIp: string | null;
  lastCheckAt: string | null;
  createdAt: string;
  /** Tipe member (additive, default 'http-proxy' utk backward compat). */
  type: MemberType;
  /** Untuk edge-relay: id provider (mis. 'cloudflare-workers'). */
  edgeProvider: string | null;
  /** Untuk edge-relay: deployed relay URL. */
  relayUrl: string | null;
}

/** Junction: provider mana pakai pool mana. */
export interface ProviderProxyBinding {
  providerId: string;
  poolId: string;
  enabled: boolean;
}

/** Outcome event proxy log. */
export type ProxyOutcome =
  | 'selected' // member dipilih utk request
  | 'served' // request sukses lewat proxy
  | 'failed' // request gagal krn proxy error
  | 'unhealthy' // member ditandai unhealthy (passive on-fail)
  | 'timeout' // health-check / request timeout
  | 'recovered'; // healthy lagi setelah sebelumnya unhealthy

/** Satu baris proxy_logs. */
export interface ProxyLogEntry {
  id: number;
  ts: string;
  poolId: string | null;
  memberId: number | null;
  memberUrl: string | null;
  providerId: string | null;
  outcome: ProxyOutcome;
  latencyMs: number | null;
  country: string | null;
  error: string | null;
  details: string | null;
}

/** Hasil lookup GeoIP. */
export interface GeoIpResult {
  country: string; // ISO code, mis. "US"
  countryName: string; // "United States"
  flag: string; // emoji "🇺🇸"
}

/** Hasil test satu proxy member. */
export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  geo: GeoIpResult | null;
  error?: string;
}

/**
 * Member terpilih + info utk build transport. Inilah satu-satunya contract yg
 * dipakai engine. Null = tidak ada proxy utk provider ini (direct fetch).
 * Engine pakai buildTransport(resolved) utk dapat {dispatcher?, relay?}.
 */
export interface ResolvedProxy {
  poolId: string;
  memberId: number;
  /** Untuk http-proxy/socks5: proxy URL. Untuk edge-relay: relay URL. */
  proxyUrl: string;
  country: string | null;
  /** Tipe member. */
  type: MemberType;
  /** Untuk edge-relay: id provider (mis. 'cloudflare-workers'). */
  edgeProvider: string | null;
  /** Untuk edge-relay: memberId utk lookup config encrypted (decrypt di buildTransport). */
  edgeMemberId: number | null;
}
