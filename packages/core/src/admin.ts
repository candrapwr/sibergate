import { randomUUID } from 'node:crypto';
import { getDb, type DB } from './db.js';
import { encryptJSON, decryptJSON, type EncryptedBlob } from './crypto.js';
import { generateApiKey } from './api-key.js';
import { providerEndpoints } from './known-providers.js';

/**
 * Admin repository — CRUD operations over the master-data tables.
 *
 * All writes go through here so encryption (provider credentials) and key
 * generation (api keys) are handled consistently. Each mutator returns the
 * affected row(s); callers reload the ConfigStore afterwards.
 *
 * Sensitive fields (credentials) are NEVER returned by read methods — only a
 * boolean `hasCredentials` is exposed.
 */

const json = (v: unknown) => JSON.stringify(v);

/** Thrown when a delete/update violates a FK (still referenced). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/* ───────────────────────────── PROVIDERS ───────────────────────────── */

export interface ProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  authScheme?: 'bearer' | 'x-api-key' | 'query' | 'basic' | 'none';
  /** Plaintext API key — encrypted here, never returned, never logged. */
  apiKey?: string;
  /** Existing encrypted blob (carried through on partial updates). */
  credentials?: string;
  /** Per-modality endpoint templates, e.g. {chat:"/v1/chat/completions", music:"/v1/inference/{model}"}. */
  endpoints?: Record<string, string>;
  base_url?: string;
  auth_scheme?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

export function createProvider(input: ProviderInput): Record<string, unknown> {
  return upsertProvider(input);
}

export function updateProvider(id: string, input: Partial<ProviderInput>): Record<string, unknown> | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
  if (!existing) return null;
  // Map existing DB row (snake_case) into ProviderInput, then apply the patch.
  const merged: ProviderInput = {
    id: existing.id,
    name: existing.name,
    baseUrl: existing.base_url,
    authScheme: existing.auth_scheme,
    credentials: existing.credentials, // keep existing encrypted blob unless apiKey provided
    endpoints: safeParse(existing.endpoints ?? '{}', {}),
    headers: safeParse(existing.headers, {}),
    timeoutMs: existing.timeout_ms ?? undefined,
    enabled: existing.enabled === 1,
  };
  Object.assign(merged, input);
  return upsertProvider(merged);
}

function upsertProvider(input: ProviderInput): Record<string, unknown> {
  const db = getDb();
  // Only re-encrypt if a fresh apiKey is provided; otherwise keep existing creds.
  let credentials = input.credentials;
  if (input.apiKey !== undefined) {
    credentials = json(encryptJSON({ apiKey: input.apiKey }));
  }
  if (credentials === undefined) {
    throw new Error('Provider apiKey is required on create.');
  }
  db.prepare(
    `INSERT INTO providers (id, name, base_url, auth_scheme, credentials, endpoints, headers, timeout_ms, enabled)
     VALUES (@id, @name, @baseUrl, @authScheme, @credentials, @endpoints, @headers, @timeoutMs, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       name=@name, base_url=@baseUrl, auth_scheme=@authScheme, credentials=@credentials,
       endpoints=@endpoints, headers=@headers, timeout_ms=@timeoutMs, enabled=@enabled, updated_at=datetime('now')`,
  ).run({
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    authScheme: input.authScheme ?? 'bearer',
    credentials,
    endpoints: json(input.endpoints ?? {}),
    headers: json(input.headers ?? {}),
    timeoutMs: input.timeoutMs ?? null,
    enabled: input.enabled === false ? 0 : 1,
  });
  return getProvider(input.id)!;
}

export function getProvider(id: string): Record<string, unknown> | null {
  return redactProvider(
    getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as any,
  );
}

export function listProviders(): Record<string, unknown>[] {
  return (getDb().prepare('SELECT * FROM providers ORDER BY id').all() as any[])
    .map(redactProvider)
    .filter((r): r is Record<string, unknown> => r !== null);
}

export function deleteProvider(id: string): boolean {
  try {
    return getDb().prepare('DELETE FROM providers WHERE id = ?').run(id).changes > 0;
  } catch {
    throw new ConflictError(
      `provider '${id}' is still referenced by a model or route target. Remove those first.`,
    );
  }
}

function redactProvider(row: any): Record<string, unknown> | null {
  if (!row) return null;
  // Decrypt to check whether a real (non-empty) key is configured — imported
  // providers store an encrypted empty string, so hasCredentials must reflect
  // an actual usable key, not just the presence of a blob.
  let hasCredentials = false;
  if (row.credentials) {
    try {
      const creds = decryptJSON<{ apiKey?: string }>(safeParse(row.credentials, {}) as EncryptedBlob);
      hasCredentials = !!creds.apiKey;
    } catch {
      hasCredentials = false;
    }
  }
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    hasCredentials,
    endpoints: safeParse(row.endpoints ?? '{}', {}),
    // Convenience: which modalities this provider can serve (endpoint keys).
    modalities: Object.keys(safeParse(row.endpoints ?? '{}', {})),
    headers: safeParse(row.headers, {}),
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ────────────────────────────── MODELS ────────────────────────────── */

export interface ModelInput {
  id: string;
  provider: string;
  displayName?: string;
  modalities?: string[];
  contextWindow?: number;
  maxOutput?: number;
  inputPricePer1m?: number;
  outputPricePer1m?: number;
  capabilities?: Record<string, boolean>;
  enabled?: boolean;
}

export function upsertModel(input: ModelInput): Record<string, unknown> {
  const db = getDb();
  db.prepare(
    `INSERT INTO models (id, provider_id, display_name, modalities, context_window, max_output,
       input_price_per_1m, output_price_per_1m, capabilities, enabled)
     VALUES (@id, @providerId, @displayName, @modalities, @contextWindow, @maxOutput,
       @inputPrice, @outputPrice, @capabilities, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       provider_id=@providerId, display_name=@displayName, modalities=@modalities,
       context_window=@contextWindow, max_output=@maxOutput, input_price_per_1m=@inputPrice,
       output_price_per_1m=@outputPrice, capabilities=@capabilities, enabled=@enabled,
       updated_at=datetime('now')`,
  ).run({
    id: input.id,
    providerId: input.provider,
    displayName: input.displayName ?? input.id,
    modalities: json(input.modalities ?? ['text-to-text']),
    contextWindow: input.contextWindow ?? null,
    maxOutput: input.maxOutput ?? null,
    inputPrice: input.inputPricePer1m ?? null,
    outputPrice: input.outputPricePer1m ?? null,
    capabilities: json(input.capabilities ?? {}),
    enabled: input.enabled === false ? 0 : 1,
  });
  return getModel(input.id)!;
}

export function getModel(id: string): Record<string, unknown> | null {
  return redactModel(getDb().prepare('SELECT * FROM models WHERE id = ?').get(id) as any);
}

export function listModels(): Record<string, unknown>[] {
  return (getDb().prepare('SELECT * FROM models ORDER BY id').all() as any[])
    .map(redactModel)
    .filter((r): r is Record<string, unknown> => r !== null);
}

export function deleteModel(id: string): boolean {
  try {
    return getDb().prepare('DELETE FROM models WHERE id = ?').run(id).changes > 0;
  } catch {
    throw new ConflictError(`model '${id}' is still referenced by a route target. Remove it from routes first.`);
  }
}

function redactModel(row: any): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider_id,
    displayName: row.display_name,
    modalities: safeParse(row.modalities, ['text-to-text']),
    contextWindow: row.context_window,
    maxOutput: row.max_output,
    inputPricePer1m: row.input_price_per_1m,
    outputPricePer1m: row.output_price_per_1m,
    capabilities: safeParse(row.capabilities, {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ────────────────────────────── ROUTES ────────────────────────────── */

export interface RouteInput {
  id: string;
  name?: string;
  /** Which adapter handles this route. Defaults to 'chat'. */
  modality?: 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music' | 'generic';
  strategy?: 'fallback' | 'fastest' | 'weighted';
  timeoutMs?: number;
  maxRetries?: number;
  retryOn?: number[];
  enabled?: boolean;
  targets?: Array<{ provider: string; model: string; priority?: number; weight?: number }>;
}

export function upsertRoute(input: RouteInput): Record<string, unknown> {
  const db = getDb();
  db.prepare(
    `INSERT INTO routes (id, name, modality, strategy, timeout_ms, max_retries, retry_on, enabled)
     VALUES (@id, @name, @modality, @strategy, @timeoutMs, @maxRetries, @retryOn, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       name=@name, modality=@modality, strategy=@strategy, timeout_ms=@timeoutMs, max_retries=@maxRetries,
       retry_on=@retryOn, enabled=@enabled, updated_at=datetime('now')`,
  ).run({
    id: input.id,
    name: input.name ?? input.id,
    modality: input.modality ?? 'chat',
    strategy: input.strategy ?? 'fallback',
    timeoutMs: input.timeoutMs ?? 30_000,
    maxRetries: input.maxRetries ?? null,
    retryOn: json(input.retryOn ?? [429, 500, 502, 503, 504, 401, 403]),
    enabled: input.enabled === false ? 0 : 1,
  });
  if (input.targets) replaceTargets(input.id, input.targets);
  return getRouteRow(input.id)!;
}

export function getRouteRow(id: string): Record<string, unknown> | null {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as any;
  if (!route) return null;
  const targets = (db
    .prepare('SELECT * FROM route_targets WHERE route_id = ? ORDER BY priority, id')
    .all(id) as any[]).map((t) => ({
    provider: t.provider_id,
    model: t.model_id,
    priority: t.priority,
    weight: t.weight,
    enabled: t.enabled === 1,
  }));
  return {
    id: route.id,
    name: route.name,
    modality: route.modality ?? 'chat',
    strategy: route.strategy,
    timeoutMs: route.timeout_ms,
    maxRetries: route.max_retries,
    retryOn: safeParse(route.retry_on, []),
    enabled: route.enabled === 1,
    targets,
    createdAt: route.created_at,
    updatedAt: route.updated_at,
  };
}

export function listRoutes(): Record<string, unknown>[] {
  return (getDb().prepare('SELECT id FROM routes ORDER BY id').all() as any[])
    .map((r) => getRouteRow(r.id))
    .filter(Boolean) as Record<string, unknown>[];
}

export function deleteRoute(id: string): boolean {
  return getDb().prepare('DELETE FROM routes WHERE id = ?').run(id).changes > 0;
}

function replaceTargets(
  routeId: string,
  targets: Array<{ provider: string; model: string; priority?: number; weight?: number }>,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM route_targets WHERE route_id = ?').run(routeId);
    const stmt = db.prepare(
      `INSERT INTO route_targets (route_id, provider_id, model_id, priority, weight, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    for (const t of targets) {
      stmt.run(routeId, t.provider, t.model, t.priority ?? 0, t.weight ?? 1);
    }
  })();
}

/* ───────────────────────────── API KEYS ───────────────────────────── */

export interface CreatedKey {
  apiKey: Record<string, unknown>;
  /** Plaintext — returned ONCE at creation. Never stored. */
  plaintext: string;
}

export function createApiKey(name: string): CreatedKey {
  const db = getDb();
  const gen = generateApiKey();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO api_keys (id, name, key_hash, key_prefix, enabled) VALUES (?, ?, ?, ?, 1)',
  ).run(id, name, gen.hash, gen.prefix);
  return { apiKey: getApiKey(id)!, plaintext: gen.plaintext };
}

export function listApiKeys(): Record<string, unknown>[] {
  return (getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[]).map(
    (row) => ({
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      enabled: row.enabled === 1,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    }),
  );
}

export function getApiKey(id: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    enabled: row.enabled === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function deleteApiKey(id: string): boolean {
  return getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

export function toggleApiKey(id: string, enabled: boolean): boolean {
  return (
    getDb()
      .prepare('UPDATE api_keys SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id).changes > 0
  );
}

/* ─────────────────────────── LOGS / STATS ─────────────────────────── */

export function recentRequests(limit = 50): Record<string, unknown>[] {
  return getDb().prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(limit) as any[];
}

export interface UsageStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalTokens: number;
  totalCostUsd: number;
  byRoute: Array<UsageBreakdown>;
  byProvider: Array<UsageBreakdown>;
  byModel: Array<UsageBreakdown>;
}

/** Aggregated usage for one dimension value (a route / provider / model). */
export interface UsageBreakdown {
  /** Dimension key (route id, provider id, or model id). */
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

export function usageStats(): UsageStats {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) as success,
         SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) as errors,
         SUM(total_tokens) as tokens,
         SUM(cost_usd) as cost
       FROM requests`,
    )
    .get() as any;
  return {
    totalRequests: totals.total ?? 0,
    successCount: totals.success ?? 0,
    errorCount: totals.errors ?? 0,
    totalTokens: totals.tokens ?? 0,
    totalCostUsd: totals.cost ?? 0,
    byRoute: breakdown(db, 'route'),
    byProvider: breakdown(db, 'provider'),
    byModel: breakdown(db, 'model'),
  };
}

/** Build a token/cost/latency breakdown grouped by one column. */
function breakdown(db: DB, col: 'route' | 'provider' | 'model'): UsageBreakdown[] {
  const rows = db
    .prepare(
      `SELECT
         ${col} AS name,
         COUNT(*) AS count,
         SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) AS errorCount,
         COALESCE(CAST(AVG(latency_ms) AS INT), 0) AS avgLatencyMs,
         COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(total_tokens), 0) AS totalTokens,
         COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM requests
       WHERE ${col} IS NOT NULL
       GROUP BY ${col}
       ORDER BY totalTokens DESC`,
    )
    .all() as any[];
  return rows.map((r) => ({
    name: r.name,
    count: r.count ?? 0,
    avgLatencyMs: r.avgLatencyMs ?? 0,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    totalTokens: r.totalTokens ?? 0,
    costUsd: r.costUsd ?? 0,
    successCount: r.successCount ?? 0,
    errorCount: r.errorCount ?? 0,
  }));
}

/**
 * Detailed usage matrix: tokens + cost grouped by provider AND model together.
 * Powers the Usage page ("which model under which provider consumes the most").
 */
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

export function usageMatrix(): UsageMatrixRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         provider, model,
         COUNT(*) AS count,
         COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(total_tokens), 0) AS totalTokens,
         COALESCE(SUM(cost_usd), 0) AS costUsd,
         COALESCE(CAST(AVG(latency_ms) AS INT), 0) AS avgLatencyMs
       FROM requests
       WHERE provider IS NOT NULL AND model IS NOT NULL
       GROUP BY provider, model
       ORDER BY totalTokens DESC`,
    )
    .all() as any[];
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    count: r.count ?? 0,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    totalTokens: r.totalTokens ?? 0,
    costUsd: r.costUsd ?? 0,
    avgLatencyMs: r.avgLatencyMs ?? 0,
  }));
}

/* ──────────────────────────── bulk operations ──────────────────────── */

/**
 * Wipe ALL master data + request logs.
 *
 * Truncates: requests, route_targets, routes, models, providers, api_keys.
 * The encryption master key + DB schema are preserved — only user data is gone.
 * Irreversible; callers should confirm with the user first.
 */
export function clearAllData(): { providers: number; models: number; routes: number; apiKeys: number; logs: number } {
  const db = getDb();
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  const before = {
    providers: count('providers'),
    models: count('models'),
    routes: count('routes'),
    apiKeys: count('api_keys'),
    logs: count('requests'),
  };
  // Order matters: children before parents (FK ON DELETE CASCADE also helps,
  // but explicit is safer against schema tweaks).
  db.transaction(() => {
    db.exec('DELETE FROM requests');
    db.exec('DELETE FROM route_targets');
    db.exec('DELETE FROM routes');
    db.exec('DELETE FROM models');
    db.exec('DELETE FROM providers');
    db.exec('DELETE FROM api_keys');
  })();
  return before;
}

export interface ImportResult {
  providersImported: number;
  providersSkipped: number;
  modelsImported: number;
  modelsSkipped: number;
}

/**
 * Import the built-in provider/model catalog (OPENAI, DeepSeek, Anthropic,
 * Gemini, Groq, …) with EMPTY credentials. Existing entries (by id) are kept
 * untouched (skipped) so operator-entered keys/prices are never clobbered.
 *
 * The operator then sets each provider's API key via the Providers page.
 */
export function importKnownProviders(providers: import('./known-providers.js').KnownProvider[]): ImportResult {
  const db = getDb();
  const result: ImportResult = { providersImported: 0, providersSkipped: 0, modelsImported: 0, modelsSkipped: 0 };

  const existingProvider = db.prepare('SELECT id FROM providers WHERE id = ?');
  const existingModel = db.prepare('SELECT id FROM models WHERE id = ?');
  const insertProvider = db.prepare(
    `INSERT INTO providers (id, name, base_url, auth_scheme, credentials, endpoints, headers, timeout_ms, enabled)
     VALUES (@id, @name, @baseUrl, @authScheme, @credentials, @endpoints, @headers, @timeoutMs, 0)`,
  );
  const insertModel = db.prepare(
    `INSERT INTO models (id, provider_id, display_name, modalities, context_window, max_output,
       input_price_per_1m, output_price_per_1m, capabilities, enabled)
     VALUES (@id, @providerId, @displayName, @modalities, @contextWindow, @maxOutput,
       @inputPrice, @outputPrice, @capabilities, 0)`,
  );
  // Blank encrypted credentials (apiKey: ''). Operator will set the real key.
  const blankCreds = json(encryptJSON({ apiKey: '' }));

  db.transaction(() => {
    for (const p of providers) {
      if (existingProvider.get(p.id)) {
        result.providersSkipped += 1;
        // Provider exists — merge in any modality endpoints from the catalog
        // that aren't already declared, so old providers (seeded before
        // multi-modality, with only {chat}) gain image/speech/etc. without
        // clobbering operator customizations. Credentials/enabled untouched.
        const row = existingProvider.get(p.id) as { endpoints?: string } | undefined;
        const current = safeParse<Record<string, string>>(row?.endpoints ?? '{}', {});
        const catalog = providerEndpoints(p);
        const merged = { ...catalog, ...current }; // current wins for conflicts
        db.prepare('UPDATE providers SET endpoints = ? WHERE id = ?').run(json(merged), p.id);
        // Still try to import any missing models for this provider.
      } else {
        insertProvider.run({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          authScheme: p.authScheme,
          credentials: blankCreds,
          endpoints: json(providerEndpoints(p)),
          headers: json({}),
          timeoutMs: null,
        });
        result.providersImported += 1;
      }
      for (const m of p.models) {
        if (existingModel.get(m.id)) {
          result.modelsSkipped += 1;
        } else {
          insertModel.run({
            id: m.id,
            providerId: p.id,
            displayName: m.displayName,
            modalities: json(m.modalities ?? ['text-to-text']),
            contextWindow: m.contextWindow ?? null,
            maxOutput: m.maxOutput ?? null,
            inputPrice: m.inputPricePer1m ?? null,
            outputPrice: m.outputPricePer1m ?? null,
            capabilities: json(m.capabilities ?? {}),
          });
          result.modelsImported += 1;
        }
      }
    }
  })();
  return result;
}

/* ────────────────────────────── helpers ───────────────────────────── */

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
