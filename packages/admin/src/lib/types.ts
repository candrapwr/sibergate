/** Types matching the gateway admin API responses. */

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key' | 'query' | 'basic' | 'none';
  hasCredentials: boolean;
  /** Jumlah upstream key tambahan di provider_keys (multi-account). */
  keyCount: number;
  endpoints: Record<string, string>;
  /** Modalities this provider can serve (keys of `endpoints`). */
  modalities: string[];
  headers: Record<string, string>;
  timeoutMs: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An upstream API key milik sebuah provider (multi-account). Plaintext tidak pernah dikembalikan API. */
export interface ProviderKey {
  id: string;
  providerId: string;
  label: string;
  /** Redacted prefix untuk display, e.g. "sk-ab12…". */
  keyPrefix: string;
  /** True bila ini adalah key default provider (dipakai saat target.keyId NULL). */
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Model {
  id: string;
  provider: string;
  displayName: string;
  modalities: string[];
  contextWindow: number | null;
  maxOutput: number | null;
  inputPricePer1m: number | null;
  outputPricePer1m: number | null;
  capabilities: Record<string, boolean>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteTarget {
  provider: string;
  model: string;
  priority: number;
  weight: number;
  enabled: boolean;
  /** Override modality per-target. null/undefined = pakai route.modality. */
  modality?: string | null;
  /** Upstream key (provider_keys.id) utk target ini. null = pakai key default provider. */
  key?: string | null;
}

export interface Route {
  id: string;
  name: string;
  /** Which adapter handles this route's requests. */
  modality: RouteModality;
  strategy: 'fallback' | 'fastest' | 'weighted';
  timeoutMs: number;
  maxRetries: number | null;
  retryOn: number[];
  enabled: boolean;
  targets: RouteTarget[];
  createdAt: string;
  updatedAt: string;
}

export type RouteModality =
  | 'chat'
  | 'image'
  | 'speech'
  | 'transcribe'
  | 'embed'
  | 'music'
  | 'generic'
  | 'responses'
  | 'tools-text'
  | 'tools-text-stream'
  | 'tools-text-nonstream';

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  // plaintext only present right after creation
  plaintext?: string;
}

/** A custom script record (list view — script source omitted). */
export interface CustomScriptSummary {
  id: string;
  name: string;
  description: string | null;
  timeoutMs: number;
  language: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Full custom script incl. source (returned by GET /:id and create/update). */
export interface CustomScript extends CustomScriptSummary {
  script: string;
}

/** Result of running a script once (POST /admin/custom-scripts/:id/test). */
export interface ScriptRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Proxy pool strategy. */
export type ProxyStrategy = 'weighted' | 'round-robin' | 'failover';
export type MemberType = 'http-proxy' | 'socks5' | 'edge-relay';
export type EdgeProviderId = 'cloudflare-workers' | 'vercel-edge' | 'deno-deploy' | 'netlify-edge';
export type EdgeProviderStatus = 'active' | 'beta' | 'coming-soon';

/** Metadata field config utk render form dinamis di DeployDialog. */
export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder?: string;
  required: boolean;
  helper?: string;
}

/** Info provider edge relay (GET /admin/proxy/edge-providers). */
export interface EdgeProviderInfo {
  id: EdgeProviderId;
  displayName: string;
  description: string;
  docsUrl?: string;
  status: EdgeProviderStatus;
  configFields: ConfigField[];
}

/** Result of edge relay verify (POST .../edge/verify). */
export interface EdgeVerifyResult {
  ok: boolean;
  accountInfo?: { accountId: string; name: string };
  error?: string;
}

/** Result of edge relay deploy (POST .../edge/deploy). */
export interface EdgeDeployResult {
  ok: boolean;
  relayUrl?: string;
  error?: string;
}

/** Standalone edge relay entity (GET /admin/proxy/edge-relays). */
export interface EdgeRelay {
  id: string;
  name: string;
  type: string;
  label: string | null;
  relayUrl: string | null;
  healthy: boolean;
  country: string | null;
  lastCheckAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  hasConfig: boolean;
}

/** Route → pool binding. */
export interface RouteProxyBinding {
  routeId: string;
  poolId: string;
  enabled: boolean;
}

/** A proxy pool (master). List view includes counts. */
export interface ProxyPool {
  id: string;
  name: string;
  strategy: ProxyStrategy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  healthyCount: number;
  boundProviderCount: number;
  boundRouteCount: number;
}

/** A member (proxy URL) inside a pool. */
export interface ProxyPoolMember {
  id: number;
  poolId: string;
  proxyUrl: string;
  label: string | null;
  weight: number;
  enabled: boolean;
  healthy: boolean;
  country: string | null;
  exitIp: string | null;
  lastCheckAt: string | null;
  createdAt: string;
  type: MemberType;
  edgeProvider: string | null;
  relayUrl: string | null;
}

/** Provider → pool binding. */
export interface ProviderProxyBinding {
  providerId: string;
  poolId: string;
  enabled: boolean;
}

/** Result of testing one proxy member. */
export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  geo: { country: string; countryName: string; flag: string } | null;
  error?: string;
}

/** One proxy_logs row. */
export interface ProxyLogEntry {
  id: number;
  ts: string;
  poolId: string | null;
  memberId: number | null;
  memberUrl: string | null;
  providerId: string | null;
  outcome: string;
  latencyMs: number | null;
  country: string | null;
  error: string | null;
  details: string | null;
}

/** GeoIP DB status (GET /admin/proxy/geoip/status). */
export interface GeoIpStatus {
  present: boolean;
  path: string;
  sizeBytes: number;
  modifiedAt: string | null;
  loadError: string | null;
}

export interface RequestLog {
  id: number;
  ts: string;
  request_id: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  route: string | null;
  provider: string | null;
  model: string | null;
  strategy: string | null;
  streamed: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  error_code: string | null;
  error_message: string | null;
  client_ip: string | null;
  metadata: string | null;
  /** 1 bila request recovered via failover (sempat gagal di ≥1 target, final 200). */
  had_failover: number | null;
}

/** One step in the failover trail (stored in request metadata JSON). */
export interface TrailStep {
  provider: string;
  model: string;
  outcome: 'served' | 'failed';
  status?: number;
  errorCode?: string;
  errorMessage?: string;
  /** Body response upstream lengkap saat step gagal (audit). */
  upstreamBody?: string | null;
  latencyMs: number;
}

/** Diagnostics from the failing upstream call (URL, status, response body). */
export interface UpstreamDiagnostics {
  url?: string;
  status?: number;
  body?: string | null;
}

export interface SystemInfo {
  configVersion: number;
  providers: number;
  models: number;
  routes: number;
  apiKeys: number;
}

export interface UsageStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalTokens: number;
  totalCostUsd: number;
  byRoute: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  byModel: UsageBreakdown[];
  byApiKey: UsageBreakdown[];
  byUpstreamKey: UsageBreakdown[];
}

/** Aggregated usage for one dimension value (route / provider / model). */
export interface UsageBreakdown {
  name: string;
  count: number;
  avgLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  successCount: number;
  errorCount: number;
}

/** provider × model usage row for the Usage page. */
export interface UsageMatrixRow {
  provider: string;
  model: string;
  count: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

/** Admin panel user (no password hash). */
export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
}

export interface ListResponse<T> {
  data: T[];
}

/** Generic error body from the gateway. */
export interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}
