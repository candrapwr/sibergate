import Database from 'better-sqlite3';
import { resolve } from 'node:path';

/**
 * SQLite is the single source of truth for SiberGate.
 *
 * Two pillars (per the original concept):
 *
 *   1. MASTER DATA (static configuration / catalog)
 *      - providers : vendor endpoints + AES-256-GCM encrypted credentials
 *      - models    : model specs, JSON modalities (text/vision/image/audio/...)
 *      - api_keys  : accepted client keys (sha256-hashed)
 *
 *   2. ROUTING ENGINE (operational/dynamic)
 *      - routes         : virtual client-facing endpoints ("smart", "chat")
 *      - route_targets  : ordered (provider,model,weight) targets per route
 *      - requests       : per-request log (latency, tokens, cost, errors)
 *
 * The DB file defaults to <cwd>/sibergate.db (override via SIBERGATE_DB).
 * Tables auto-create on first connect.
 */

export type DB = Database.Database;

let dbInstance: DB | null = null;

export function getDb(dbPath: string = process.env.SIBERGATE_DB ?? 'sibergate.db'): DB {
  if (dbInstance) return dbInstance;
  const db = new Database(resolve(process.cwd(), dbPath));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  dbInstance = db;
  return db;
}

/**
 * Close the current DB connection and null the singleton so the next `getDb()`
 * re-opens against the (possibly overwritten) file. Used by `restoreBackup`,
 * which overwrites sibergate.db on disk: the old connection points at a stale
 * file and would crash on any query. After this, `getDb()` returns a fresh
 * connection to the restored DB. Safe to call when no instance exists.
 */
export function resetDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* may already be closed */
    }
    dbInstance = null;
  }
}

function migrate(db: DB): void {
  db.exec(`
    -- ════════════════════════════════════════════════════════════
    -- PILLAR 1: MASTER DATA
    -- ════════════════════════════════════════════════════════════

    -- Provider Management: vendor endpoint + encrypted credentials.
    CREATE TABLE IF NOT EXISTS providers (
      id            TEXT PRIMARY KEY,            -- 'openai', 'deepseek', 'ollama'
      name          TEXT NOT NULL,               -- display name
      base_url      TEXT NOT NULL,               -- e.g. https://api.openai.com/v1
      auth_scheme   TEXT NOT NULL DEFAULT 'bearer', -- bearer | x-api-key
      -- AES-256-GCM encrypted blob (JSON: {iv,ct,tag}) holding {apiKey:'sk-...'}
      credentials   TEXT NOT NULL,
      headers       TEXT NOT NULL DEFAULT '{}',  -- extra upstream headers (JSON)
      timeout_ms    INTEGER,                     -- per-provider timeout override
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Model Directory: spec per provider, JSON modalities for future-proofing.
    CREATE TABLE IF NOT EXISTS models (
      id              TEXT PRIMARY KEY,          -- 'gpt-4o-mini'
      provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      display_name    TEXT NOT NULL,
      -- JSON array: ['text-to-text','vision','image-generation','audio','embeddings']
      modalities      TEXT NOT NULL DEFAULT '["text-to-text"]',
      context_window  INTEGER,
      max_output      INTEGER,
      input_price_per_1m  REAL,                  -- USD / 1M tokens (cost logging)
      output_price_per_1m REAL,
      capabilities    TEXT NOT NULL DEFAULT '{}', -- {supports_streaming, supports_tools, ...}
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

    -- Client API keys (sha256-hashed; plaintext shown once at seed time).
    CREATE TABLE IF NOT EXISTS api_keys (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      key_hash      TEXT NOT NULL UNIQUE,        -- sha256 hex
      key_prefix    TEXT NOT NULL,               -- 'sg_live_ab12' for display
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_used_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    -- ════════════════════════════════════════════════════════════
    -- PILLAR 2: ROUTING ENGINE
    -- ════════════════════════════════════════════════════════════

    -- Gateway Routes: virtual endpoints clients call.
    CREATE TABLE IF NOT EXISTS routes (
      id            TEXT PRIMARY KEY,            -- 'smart', 'chat', 'balanced'
      name          TEXT NOT NULL,
      strategy      TEXT NOT NULL DEFAULT 'fallback', -- fallback|fastest|weighted
      timeout_ms    INTEGER NOT NULL DEFAULT 30000,
      max_retries   INTEGER,                     -- default = #targets
      retry_on      TEXT NOT NULL DEFAULT '[429,500,502,503,504,401,403]', -- JSON status codes
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Dynamic Mapping: route -> ordered (provider, model) targets.
    CREATE TABLE IF NOT EXISTS route_targets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL REFERENCES providers(id),
      model_id      TEXT NOT NULL REFERENCES models(id),
      priority      INTEGER NOT NULL DEFAULT 0,  -- lower = tried first (fallback)
      weight        INTEGER NOT NULL DEFAULT 1,  -- relative (weighted strategy)
      enabled       INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_route_targets_route ON route_targets(route_id);

    -- Request log (observability).
    CREATE TABLE IF NOT EXISTS requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                TEXT NOT NULL DEFAULT (datetime('now')),
      request_id        TEXT,
      method            TEXT,
      path              TEXT,
      status            INTEGER,
      latency_ms        INTEGER,
      route             TEXT,
      provider          TEXT,
      model             TEXT,
      strategy          TEXT,
      streamed          INTEGER,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      total_tokens      INTEGER,
      cost_usd          REAL,
      error_code        TEXT,
      error_message     TEXT,
      client_ip         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
  `);

  // ── additive migrations (idempotent): new columns for multi-modality ──
  // ALTER TABLE ADD COLUMN errors if the column exists, so guard each with a
  // check against pragma_table_info. This keeps existing DBs working without a
  // separate migration runner.
  addColumnIfMissing(db, 'providers', 'endpoints', "TEXT NOT NULL DEFAULT '{}'");
  // Per-modality endpoint map, e.g.
  //   {"chat":"/v1/chat/completions","images":"/v1/images/generations",
  //    "music":"/v1/inference/{model}"}
  // A provider only serves a modality if its endpoints map has that key.

  addColumnIfMissing(db, 'routes', 'modality', "TEXT NOT NULL DEFAULT 'chat'");
  // Which kind of request this route handles: chat | image | speech | transcribe | embed | music

  addColumnIfMissing(db, 'requests', 'modality', "TEXT");
  // For logging: which modality a request used (chat by default).

  // ── admin panel users (login) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      -- scrypt hash: "scrypt:<N>:<salt_hex>:<hash_hex>"
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',  -- owner | admin | viewer
      status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
      last_login_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  // Failover audit trail stored as JSON (array of {provider, model, outcome, error}).
  addColumnIfMissing(db, 'requests', 'metadata', "TEXT NOT NULL DEFAULT '{}'");
}

/** Add a column only if it doesn't already exist (idempotent migration). */
function addColumnIfMissing(db: DB, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
  }
}
