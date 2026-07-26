import { randomUUID } from 'node:crypto';
import { getDb, type DB } from './db.js';
import { encryptJSON, decryptJSON, type EncryptedBlob } from './crypto.js';
import { generateApiKey } from './api-key.js';
import { providerEndpoints } from './known-providers.js';
import { resetLatency } from './latency.js';
import { listSignatures as listSigs, resetSignatures as resetSigs, type SignatureList } from './signatures.js';

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

/** Thrown when input fails validation (bad id, bad shape). Maps to HTTP 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate an id used as a URL path segment (route id, provider id).
 *
 * These ids become part of the URL (e.g. /v1/proxy/:routeId, /admin/routes/:id),
 * so they must NOT contain characters that break path parsing: slashes, spaces,
 * or be empty. Model ids are EXEMPT (they conventionally contain a slash, e.g.
 * "anthropic/claude-sonnet-4.6") and are handled by the wildcard route.
 */
export function assertValidPathId(kind: string, id: string, opts: { allowSlash?: boolean } = {}): void {
  const trimmed = id?.trim();
  if (!trimmed) {
    throw new ValidationError(`${kind} id must not be empty.`);
  }
  // Tolak whitespace selalu. Slash hanya boleh bila allowSlash (mis. Route id
  // multi-segment 'app/secret'). Provider id TIDAK boleh slash krn jadi prefix
  // model id ('{provider}/...') — slash di provider bikin ambigu saat strip.
  if (/\s/.test(trimmed)) {
    throw new ValidationError(`${kind} id "${trimmed}" is invalid: it must not contain whitespace.`);
  }
  if (!opts.allowSlash && /[\/]/.test(trimmed)) {
    throw new ValidationError(
      `${kind} id "${trimmed}" is invalid: it must not contain slashes ` +
        `(it becomes part of the URL). Use letters, numbers, '-', or '_'.`,
    );
  }
  if (opts.allowSlash) {
    // Tolak trailing/leading slash dan segment kosong ('/a', 'a//b', 'a/').
    if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('//')) {
      throw new ValidationError(
        `${kind} id "${trimmed}" is invalid: each segment between slashes must be non-empty.`,
      );
    }
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
  assertValidPathId('Provider', input.id);
  const db = getDb();
  // Credentials default (providers.credentials) kini opsional — key utama dikelola
  // via provider_keys (UI satu tempat). Backward-compat: bila apiKey di-set (mis.
  // API lama / import), tetap tulis ke credentials. Bila tidak, pakai blob kosong.
  let credentials = input.credentials;
  if (input.apiKey !== undefined) {
    credentials = json(encryptJSON({ apiKey: input.apiKey }));
  } else if (credentials === undefined) {
    // Create tanpa key sama sekali — provider bisa di-add dulu, key di-set
    // kemudian via POST /providers/:id/keys. Pakai blob kosong (NOT NULL constraint).
    credentials = json(encryptJSON({ apiKey: '' }));
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

/* ───────────────────────── PROVIDER KEYS (multi-account) ─────────────────────────
 * Upstream API keys per provider. Satu provider boleh punya beberapa key (mis.
 * beberapa akun OpenAI); masing-masing di-assign ke route target via
 * target.keyId supaya engine bisa pilih akun spesifik per target.
 * Plaintext value TIDAK PERNAH di-return API — hanya label + prefix (redacted).
 */

export interface ProviderKeyInput {
  label: string;
  /** Plaintext API key — encrypted here, never returned, never logged. */
  apiKey: string;
}

export interface ProviderKeyView {
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

function redactProviderKey(row: any): ProviderKeyView {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    keyPrefix: row.key_prefix,
    isDefault: row.is_default === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeKeyPrefix(value: string): string {
  // Ambil 8 char pertama (atau semua bila kurang) + elipsis, utk display.
  const head = value.slice(0, 8);
  return value.length > 8 ? `${head}…` : head;
}

export function listProviderKeys(providerId: string): ProviderKeyView[] {
  // Urutkan: default key duluan (supaya UI menampilkannya paling atas).
  return (getDb()
    .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY is_default DESC, created_at')
    .all(providerId) as any[]).map(redactProviderKey);
}

export function createProviderKey(providerId: string, input: ProviderKeyInput): ProviderKeyView {
  const db = getDb();
  // Pastikan provider ada.
  const exists = db.prepare('SELECT 1 FROM providers WHERE id = ?').get(providerId);
  if (!exists) throw new ValidationError(`Provider '${providerId}' not found.`);
  const label = input.label?.trim();
  if (!label) throw new ValidationError('Key label must not be empty.');
  if (!input.apiKey) throw new ValidationError('API key value must not be empty.');
  const id = randomUUID();
  const credentials = json(encryptJSON({ apiKey: input.apiKey }));
  // Key pertama utk provider ini otomatis jadi default (invarian: tepat 1 default
  // per provider). Key berikutnya bukan default kecuali user set manual.
  const hasDefault = (
    db
      .prepare('SELECT COUNT(*) AS c FROM provider_keys WHERE provider_id = ? AND is_default = 1')
      .get(providerId) as { c: number }
  ).c;
  const isDefault = hasDefault === 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO provider_keys (id, provider_id, label, credentials, key_prefix, is_default, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, providerId, label, credentials, makeKeyPrefix(input.apiKey), isDefault);
  return getProviderKey(id)!;
}

/** Tandai sebuah key sebagai default provider-nya (clear flag default lainnya).
 *  Invarian: tepat satu key default per provider. */
export function setDefaultProviderKey(id: string): ProviderKeyView | null {
  const db = getDb();
  const key = db.prepare('SELECT provider_id FROM provider_keys WHERE id = ?').get(id) as
    | { provider_id: string }
    | undefined;
  if (!key) return null;
  db.transaction(() => {
    db.prepare('UPDATE provider_keys SET is_default = 0 WHERE provider_id = ?').run(key.provider_id);
    db.prepare('UPDATE provider_keys SET is_default = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  })();
  return getProviderKey(id)!;
}

export function getProviderKey(id: string): ProviderKeyView | null {
  const row = getDb().prepare('SELECT * FROM provider_keys WHERE id = ?').get(id) as any;
  return row ? redactProviderKey(row) : null;
}

export function updateProviderKey(
  id: string,
  patch: { label?: string; enabled?: boolean; apiKey?: string; isDefault?: boolean },
): ProviderKeyView | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(id) as any;
  if (!existing) return null;
  const label = patch.label !== undefined ? patch.label.trim() : existing.label;
  if (!label) throw new ValidationError('Key label must not be empty.');
  // Rotate value hanya bila apiKey baru diberikan; selain itu pertahankan blob lama.
  const credentials =
    patch.apiKey !== undefined ? json(encryptJSON({ apiKey: patch.apiKey })) : existing.credentials;
  const keyPrefix =
    patch.apiKey !== undefined ? makeKeyPrefix(patch.apiKey) : existing.key_prefix;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
  db.prepare(
    `UPDATE provider_keys SET label = ?, credentials = ?, key_prefix = ?, enabled = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(label, credentials, keyPrefix, enabled, id);
  // Set default ditangani terpisah (perlu clear flag lain) — bila patch.isDefault
  // true, delegasikan ke setDefaultProviderKey utk jaga invarian.
  if (patch.isDefault) return setDefaultProviderKey(id);
  return getProviderKey(id)!;
}

export function deleteProviderKey(id: string): boolean {
  const db = getDb();
  // route_targets.key_id ON DELETE SET NULL (FK) → target yg menunjuk key ini
  // otomatis jatuh kembali ke provider.apiKey default.
  const key = db.prepare('SELECT provider_id, is_default FROM provider_keys WHERE id = ?').get(id) as
    | { provider_id: string; is_default: number }
    | undefined;
  if (!key) return false;
  const removed = db.prepare('DELETE FROM provider_keys WHERE id = ?').run(id).changes > 0;
  // Bila key default dihapus, promosikan key lain (yg masih ada) jadi default
  // supaya invarian "tepat 1 default per provider" tetap terjaga (selama masih
  // ada key tersisa). Pilih key enabled pertama by created_at.
  if (removed && key.is_default === 1) {
    const next = db
      .prepare('SELECT id FROM provider_keys WHERE provider_id = ? ORDER BY enabled DESC, created_at LIMIT 1')
      .get(key.provider_id) as { id: string } | undefined;
    if (next) {
      db.prepare('UPDATE provider_keys SET is_default = 1 WHERE id = ?').run(next.id);
    }
  }
  return removed;
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
  // Jumlah upstream key tambahan di tabel provider_keys (multi-account). Bila
  // ada ≥1 key di sana, provider dianggap punya kredensial meski credentials
  // default kosong — key-key tsb yg dipakai target dgn target.keyId.
  const keyCount = (
    getDb().prepare('SELECT COUNT(*) AS c FROM provider_keys WHERE provider_id = ?').get(row.id) as {
      c: number;
    }
  ).c;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    hasCredentials: hasCredentials || keyCount > 0,
    keyCount,
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
  // Defense-in-depth: tolak id kosong / hanya prefix provider (mis. 'exa_ai_1/').
  // Tanpa ini, nama model kosong lolos tersimpan dgn id '' atau 'provider/' yg
  // tidak bisa dihapus via URL krn trailing slash ambigu. Normalisasi penuh ada
  // di POST route, tapi API direct / internal caller tetap perlu dijaga di sini.
  const trimmedId = (input.id ?? '').trim();
  const trimmedProvider = (input.provider ?? '').trim();
  if (!trimmedId || !trimmedProvider) {
    throw new ValidationError('Model id and provider must not be empty.');
  }
  if (trimmedId.endsWith('/')) {
    throw new ValidationError(`Model id "${trimmedId}" is invalid: it ends with a slash, meaning the model name is empty.`);
  }
  input.id = trimmedId;
  input.provider = trimmedProvider;

  // Konflik pada composite (provider_id, id) — sehingga model dgn nama yg sama
  // di provider berbeda menjadi baris terpisah, bukan menimpa baris provider lain.
  // Sebelumnya konflik pada `id` saja, yg diam-diam menimpa baris provider manapun
  // yg kebetulan memakai id sama — inilah bug "model baru menimpa provider lain".
  db.prepare(
    `INSERT INTO models (id, provider_id, display_name, modalities, context_window, max_output,
       input_price_per_1m, output_price_per_1m, capabilities, enabled)
     VALUES (@id, @providerId, @displayName, @modalities, @contextWindow, @maxOutput,
       @inputPrice, @outputPrice, @capabilities, @enabled)
     ON CONFLICT(provider_id, id) DO UPDATE SET
       display_name=@displayName, modalities=@modalities,
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
  const db = getDb();
  // 1. Exact match by id (konvensi namespaced 'provider/name' selalu unik).
  const exact = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
  if (exact) return redactModel(exact);
  // 2. Fallback: id tanpa prefix (mis. 'gpt-4o-mini') — ambil baris pertama.
  //    Backward-compat utk data/URL lama. Jika ada duplikat lintas provider, yg
  //    dikembalikan tidak deterministik; konvensi namespaced tetap disarankan.
  const byName = db.prepare('SELECT * FROM models WHERE id = ? OR id LIKE ? ORDER BY id LIMIT 1')
    .get(id, `%/${id}`) as any;
  return redactModel(byName);
}

/**
 * Lookup eksplisit by composite key (provider_id, id). Tepat satu baris atau
 * null — dipakai utk mengecek duplikat saat create, tanpa fallback ambigu.
 */
export function findModel(providerId: string, id: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare('SELECT * FROM models WHERE provider_id = ? AND id = ?')
    .get(providerId, id) as any;
  return redactModel(row);
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
  modality?: 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music' | 'generic' | 'responses' | 'tools-text';
  strategy?: 'fallback' | 'fastest' | 'weighted';
  timeoutMs?: number;
  maxRetries?: number;
  retryOn?: number[];
  enabled?: boolean;
  /**
   * Targets route. Tiap target boleh override modality (mis. OpenAI pakai
   * 'responses' sementara route default-nya 'chat'). Bila modality target
   * null/undefined → pakai route.modality.
   */
  targets?: Array<{
    provider: string;
    model: string;
    priority?: number;
    weight?: number;
    modality?: 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music' | 'generic' | 'responses' | 'tools-text' | null;
  }>;
}

export function upsertRoute(input: RouteInput): Record<string, unknown> {
  // Route id boleh multi-segment ('app/secret', 'team/prod/chat') — kini
  // diizinkan supaya operator bisa atur route secara hierarkis. Setiap segment
  // antar slash harus non-empty (tidak boleh 'a//b' atau 'a/').
  assertValidPathId('Route', input.id, { allowSlash: true });
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
    // modality null = pakai route.modality (default behavior, backward compat).
    modality: t.modality ?? null,
    // key_id null = pakai provider.apiKey default; bila di-set, merujuk ke
    // provider_keys.id (assign upstream key spesifik ke target ini).
    key: t.key_id ?? null,
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
  targets: Array<{
    provider: string;
    model: string;
    priority?: number;
    weight?: number;
    modality?: string | null;
    key?: string | null;
  }>,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM route_targets WHERE route_id = ?').run(routeId);
    const stmt = db.prepare(
      `INSERT INTO route_targets (route_id, provider_id, model_id, priority, weight, enabled, modality, key_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const t of targets) {
      // modality NULL = pakai route.modality (default). String kosong dianggap NULL.
      const mod = t.modality && t.modality.trim() ? t.modality.trim() : null;
      // key NULL = pakai provider.apiKey default. String kosong dianggap NULL.
      const keyId = t.key && t.key.trim() ? t.key.trim() : null;
      stmt.run(routeId, t.provider, t.model, t.priority ?? 0, t.weight ?? 1, mod, keyId);
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

/**
 * Rotate the secret of an existing API key (same id/name/enabled, new secret).
 *
 * The old plaintext can't be recovered (sha256 is one-way), so regenerate mints
 * a brand-new secret and overwrites key_hash + key_prefix. The old secret stops
 * authenticating immediately. Returns the new plaintext ONCE (like createApiKey).
 */
export function regenerateApiKey(id: string): CreatedKey | null {
  const db = getDb();
  if (!getApiKey(id)) return null;
  const gen = generateApiKey();
  const changed = db
    .prepare('UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ?')
    .run(gen.hash, gen.prefix, id).changes > 0;
  if (!changed) return null;
  return { apiKey: getApiKey(id)!, plaintext: gen.plaintext };
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
  byApiKey: Array<UsageBreakdown>;
  byUpstreamKey: Array<UsageBreakdown>;
}

/** Aggregated usage for one dimension value (a route / provider / model / api key). */
export interface UsageBreakdown {
  /** Dimension key (route id, provider id, model id, atau nama API key). */
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
    byApiKey: breakdownByApiKey(db),
    byUpstreamKey: breakdownByUpstreamKey(db),
  };
}

/**
 * Breakdown usage per API key. JOIN ke api_keys utk dapat nama (lebih manusiawi
 * drpd id internal). Request auth-open (api_key_id NULL) dikelompokkan di bawah
 * nama '(auth-open)' supaya tetap terlihat di dashboard.
 */
function breakdownByApiKey(db: DB): UsageBreakdown[] {
  // LEFT JOIN krn api_key_id mungkin NULL atau merujuk key yg sudah dihapus.
  const rows = db
    .prepare(
      `SELECT
         CASE
           WHEN r.api_key_id IS NULL THEN '(auth-open)'
           WHEN k.name IS NOT NULL THEN k.name
           ELSE '(deleted)'
         END AS name,
         COUNT(*) AS count,
         SUM(CASE WHEN r.status = 200 THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN r.status != 200 THEN 1 ELSE 0 END) AS errorCount,
         COALESCE(CAST(AVG(r.latency_ms) AS INT), 0) AS avgLatencyMs,
         COALESCE(SUM(r.prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(r.completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(r.total_tokens), 0) AS totalTokens,
         COALESCE(SUM(r.cost_usd), 0) AS costUsd
       FROM requests r
       LEFT JOIN api_keys k ON k.id = r.api_key_id
       GROUP BY CASE
           WHEN r.api_key_id IS NULL THEN '(auth-open)'
           WHEN k.name IS NOT NULL THEN k.name
           ELSE '(deleted)'
         END
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
 * Breakdown usage per upstream API key (provider_keys). JOIN ke provider_keys utk
 * dapat label (lebih manusiawi drpd id internal). Request yg dilayani dgn key
 * default provider (upstream_key_id NULL) dikelompokkan PER PROVIDER dgn suffix
 * '(default)' — mis. 'deepseek (default)', 'gemini (default)' — supaya key
 * default tiap provider terpisah, bukan tergabung jadi satu group besar. Ini
 * penting krn tiap provider punya kredensial default sendiri di providers.credentials.
 */
function breakdownByUpstreamKey(db: DB): UsageBreakdown[] {
  // LEFT JOIN krn upstream_key_id mungkin NULL (key default) atau merujuk key
  // yg sudah dihapus (ON DELETE SET NULL → juga NULL). Group key default per
  // provider (COALESCE provider, '(unknown)') supaya tidak tergabung semua.
  const rows = db
    .prepare(
      `SELECT
         CASE
           WHEN r.upstream_key_id IS NULL THEN COALESCE(r.provider, '(unknown)') || ' (default)'
           WHEN k.label IS NOT NULL THEN k.label
           ELSE COALESCE(r.provider, '(unknown)') || ' (deleted key)'
         END AS name,
         COUNT(*) AS count,
         SUM(CASE WHEN r.status = 200 THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN r.status != 200 THEN 1 ELSE 0 END) AS errorCount,
         COALESCE(CAST(AVG(r.latency_ms) AS INT), 0) AS avgLatencyMs,
         COALESCE(SUM(r.prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(r.completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(r.total_tokens), 0) AS totalTokens,
         COALESCE(SUM(r.cost_usd), 0) AS costUsd
       FROM requests r
       LEFT JOIN provider_keys k ON k.id = r.upstream_key_id
       GROUP BY CASE
           WHEN r.upstream_key_id IS NULL THEN COALESCE(r.provider, '(unknown)') || ' (default)'
           WHEN k.label IS NOT NULL THEN k.label
           ELSE COALESCE(r.provider, '(unknown)') || ' (deleted key)'
         END
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

/**
 * Hapus semua baris di tabel `requests` (request log). Tidak menyentuh master
 * data (providers/models/routes/api_keys). Dipakai tombol "Clear logs" di
 * Settings. Master data tetap, tapi usage/stats (yg dihitung dari requests
 * saat runtime) otomatis ikut kosong.
 */
export function clearLogs(): { logs: number } {
  const db = getDb();
  const before = (db.prepare('SELECT COUNT(*) as c FROM requests').get() as { c: number }).c;
  db.exec('DELETE FROM requests');
  // Reset autoincrement counter supaya log baru mulai dari id 1 lagi (cosmetic,
  // dan menjaga id tetap kecil setelah purge besar).
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'requests'");
  return { logs: before };
}

/**
 * Reset stats: kombinasi clearLogs() + reset latency EMA in-memory (dipakai
 * strategi 'fastest'). Karena stats/usage di SiberGate tidak punya tabel
 * tersendiri (dihitung dari requests saat runtime), reset stats = bersihkan
 * requests + kosongkan latency tracker. Konfigurasi (providers/dll) tidak
 * tersentuh.
 */
export function resetStats(): { logs: number; latencyEntries: number } {
  const logs = clearLogs();
  const latency = resetLatency();
  return { logs: logs.logs, latencyEntries: latency.cleared };
}

/* ─────────── Signature cache (Gemini thought_signature) ───────────
 * Wrap module fn dari signatures.ts supaya bisa dipanggi via admin API (UI
 * Settings bisa lihat jumlah & clear manual). Lihat signatures.ts utk detail. */

/** Snapshot cache signature utk monitoring UI (count + sample entries). */
export function listSignatureCache(): SignatureList {
  return listSigs();
}

/** Hapus semua signature dari cache. Return jumlah yg dihapus. */
export function clearSignatures(): { cleared: number } {
  return resetSigs();
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
  // Cek duplikat by composite (provider_id, id) — bukan id global. Sehingga
  // model dgn nama sama milik provider berbeda tetap diimpor sebagai baris baru.
  const existingModel = db.prepare('SELECT id FROM models WHERE provider_id = ? AND id = ?');
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
        // Konvensi id namespaced '{provider}/{name}'. id dianggap sudah namespaced
        // HANYA bila diawali persis '{provider_id}/'; sekadar mengandung '/' (mis.
        // 'deepseek/deepseek-r1' milik provider 'novita', atau 'meta-llama/...'
        // milik provider 'deepinfra') TIDAK cukup — harus diprefik ulang supaya
        // unik antar provider (lihat juga migrateModelsCompositePk di db.ts).
        const modelId = m.id.startsWith(`${p.id}/`) ? m.id : `${p.id}/${m.id}`;
        if (existingModel.get(p.id, modelId)) {
          result.modelsSkipped += 1;
        } else {
          insertModel.run({
            id: modelId,
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
