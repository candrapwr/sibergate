/** Types matching the gateway admin API responses. */

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key' | 'query' | 'basic' | 'none';
  hasCredentials: boolean;
  endpoints: Record<string, string>;
  /** Modalities this provider can serve (keys of `endpoints`). */
  modalities: string[];
  headers: Record<string, string>;
  timeoutMs: number | null;
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

export type RouteModality = 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music' | 'generic';

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
}

/** One step in the failover trail (stored in request metadata JSON). */
export interface TrailStep {
  provider: string;
  model: string;
  outcome: 'served' | 'failed';
  status?: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
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
