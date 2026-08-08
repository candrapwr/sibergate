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
  MemberType,
} from './types.js';

// Edge relay registry (CF + future Vercel/Deno/AWS).
export {
  listEdgeProviders,
  getEdgeProvider,
  isEdgeProvider,
  type EdgeProviderId,
  type EdgeRelayProvider,
  type EdgeRelayRuntime,
  type VerifyResult,
  type DeployResult,
  type RemoveResult,
  type ConnectivityResult,
} from './edge/index.js';

// Runtime resolver (dipakai engine).
export { resolveProxy } from './resolver.js';

// Transport (centralized dispatcher vs relay decision).
export { buildTransport, type Transport } from './transport.js';

// Dispatcher (dipakai sendUpstream utk inject ke fetch, http/socks).
export {
  buildDispatcher,
  validateProxyUrl,
  evictDispatcher,
  clearDispatcherCache,
} from './dispatcher.js';

// Health + test (dipakai admin routes + engine on-fail).
export {
  testProxy,
  testMember,
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
  getActivePoolForRoute,
  listRouteBindings,
  bindRouteToPool,
  unbindRouteFromPool,
  getMemberEdgeConfig,
  setMemberEdgeConfig,
  setMemberRelayUrl,
  verifyEdgeCredentials,
  deployEdgeMember,
  removeEdgeDeployment,
  type ProxyPoolInput,
  type PoolMemberInput,
} from './admin.js';

// Edge relays standalone CRUD (deploy sekali, reuse).
export {
  createEdgeRelay,
  updateEdgeRelay,
  getEdgeRelay,
  listEdgeRelays,
  deleteEdgeRelay,
  getRelayConfig,
  verifyEdgeRelay,
  deployEdgeRelay,
  removeEdgeRelayDeployment,
  testEdgeRelay,
  type EdgeRelay,
  type EdgeRelayInput,
} from './edge-relay-admin.js';

// Logging (dipakai engine + admin).
export { pushProxyLog, recentProxyLogs, clearProxyLogs } from './log.js';

// Selector (re-export utk test).
export { resetSelectionState } from './selector.js';
