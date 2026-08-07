/**
 * Proxy Layer — outbound proxy pools selektif per provider.
 * Modul terisolasi. Engine hanya butuh `resolveProxy()` + `buildDispatcher()`.
 */
export type {
  ProxyStrategy,
  ProxyPool,
  ProxyPoolMember,
  ProviderProxyBinding,
  ProxyOutcome,
  ProxyLogEntry,
  GeoIpResult,
  ProxyTestResult,
  ResolvedProxy,
} from './types.js';

// Runtime resolver (dipakai engine).
export { resolveProxy } from './resolver.js';

// Dispatcher (dipakai sendUpstream utk inject ke fetch).
export {
  buildDispatcher,
  validateProxyUrl,
  evictDispatcher,
  clearDispatcherCache,
} from './dispatcher.js';

// Health + test (dipakai admin routes + engine on-fail).
export {
  testProxy,
  updateMemberHealth,
  markMemberUnhealthy,
  startHealthMonitor,
  stopHealthMonitor,
  redactProxyUrl,
} from './health.js';

// GeoIP (dipakai admin + health).
export {
  lookupCountry,
  countryCodeToFlag,
  geoipStatus,
  geoipDbPath,
  reloadGeoIp,
} from './geoip.js';

// Downloader (dipakai admin settings).
export { downloadGeoIpDb } from './downloader.js';

// Admin CRUD (dipakai gateway admin routes).
export {
  createProxyPool,
  updateProxyPool,
  getProxyPool,
  listProxyPools,
  deleteProxyPool,
  listPoolMembers,
  addPoolMember,
  getPoolMember,
  updatePoolMember,
  deletePoolMember,
  listPoolBindings,
  bindProviderToPool,
  unbindProviderFromPool,
  getActivePoolForProvider,
  type ProxyPoolInput,
  type PoolMemberInput,
} from './admin.js';

// Logging (dipakai engine + admin).
export { pushProxyLog, recentProxyLogs, clearProxyLogs } from './log.js';

// Selector (re-export utk test).
export { resetSelectionState } from './selector.js';
