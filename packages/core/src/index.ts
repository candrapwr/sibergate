export * from './types.js';
export { getDb, resetDb, type DB } from './db.js';
export { loadConfigFromDb, getRoute } from './config.js';
export { loadDotEnv } from './env.js';
export { encryptJSON, decryptJSON, sha256Hex, type EncryptedBlob } from './crypto.js';
export { generateApiKey, hashApiKey, extractBearer, type GeneratedKey } from './api-key.js';
export { seed } from './seed.js';
export { callProvider, GatewayCallError, isFailoverable } from './provider.js';
export {
  convertChatRequestToResponses,
  convertResponsesToChat,
  createResponsesStreamConverter,
  type ChatCompletionResponse,
  type ChatToolCall,
} from './adapters/responses.js';
export { executeRoute, type ExecuteResult, type FailoverStep } from './engine.js';
export {
  convertChatRequestToToolsText,
  convertToolsTextToChat,
  createToolsTextStreamConverter,
  normalizeChatUsage,
  type ChatToolCall as ToolsTextChatToolCall,
} from './adapters/tools-text.js';
export { recordLatency, recordFailure, getLatency, hasLatencyEstimate, resetLatency } from './latency.js';
export {
  storeSignature,
  getSignature,
  getDefaultSignature,
  listSignatures,
  resetSignatures,
  type SignatureList,
  type SignatureListEntry,
} from './signatures.js';
export {
  storeReasoning,
  getReasoning,
  reasoningKeyFor,
  reasoningCacheSize,
} from './reasoning.js';
export {
  saveRequestTrace,
  readRequestTrace,
  clearRequestTraces,
  type RequestTraceData,
} from './request-trace.js';
export { logRequest, touchApiKey, type LogRequest } from './logger.js';
export {
  pushConsoleLog,
  recentConsoleLogs,
  subscribeConsoleLogs,
  type ConsoleLogEntry,
  type ConsoleLogLevel,
  type ConsoleLogCategory,
} from './console-log.js';
export { ConfigStore } from './config-store.js';
export * as admin from './admin.js';
export { ConflictError, ValidationError } from './admin.js';
export { KNOWN_PROVIDERS, KNOWN_STATS } from './known-providers.js';
export type { KnownProvider, KnownModel } from './known-providers.js';
export {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_COOKIE,
  authenticate,
  createUser,
  findUserById,
  findUserByEmail,
  userCount,
  listUsers,
  deleteUser,
  setUserStatus,
  updateUser,
  type User,
  type SafeUser,
} from './auth.js';
export { estimateTokens, computeCost } from './tokens.js';
export {
  createBackup,
  restoreBackup,
  backupToJson,
  parseBackup,
  type BackupPayload,
} from './backup.js';
export {
  createScript,
  updateScript,
  getScript,
  getScriptByName,
  listScripts,
  deleteScript,
  executeScript,
  assertValidScriptId,
  type CustomScript,
  type CustomScriptSummary,
  type ScriptInput,
  type ScriptRequestInput,
  type ScriptRunResult,
  type ExecuteScriptOptions,
} from './custom-scripts.js';
export {
  mapReasoning,
  effortToBudget,
  type ReasoningEffort,
} from './reasoning-mapper.js';
export {
  // runtime
  resolveProxy,
  buildDispatcher,
  buildTransport,
  validateProxyUrl,
  testProxy,
  testMember,
  updateMemberHealth,
  startHealthMonitor,
  stopHealthMonitor,
  markMemberUnhealthy,
  redactProxyUrl,
  lookupCountry,
  countryCodeToFlag,
  geoipStatus,
  geoipDbPath,
  reloadGeoIp,
  downloadGeoIpDb,
  pushProxyLog,
  recentProxyLogs,
  clearProxyLogs,
  // admin CRUD
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
  // edge relays standalone
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
  // edge relay registry
  listEdgeProviders,
  getEdgeProvider,
  isEdgeProvider,
  type EdgeProviderId,
  type EdgeRelayRuntime,
  type ProxyPool,
  type ProxyPoolMember,
  type ProviderProxyBinding,
  type ProxyLogEntry,
  type ProxyStrategy,
  type ProxyTestResult,
  type GeoIpResult,
  type ResolvedProxy,
  type MemberType,
} from './proxy/index.js';
