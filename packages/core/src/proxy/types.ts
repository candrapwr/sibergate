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

/** Anggota pool (satu proxy URL + weight + health state). */
export interface ProxyPoolMember {
  id: number;
  poolId: string;
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
 * Member terpilih + dispatcher siap pakai. Inilah satu-satunya contract yg
 * dipakai engine. Null = tidak ada proxy utk provider ini (direct fetch).
 */
export interface ResolvedProxy {
  poolId: string;
  memberId: number;
  proxyUrl: string;
  country: string | null;
}
