import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptJSON, encryptJSON } from './crypto.js';

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
    -- Identity is COMPOSITE (provider_id, id): the same model name (e.g.
    -- 'gpt-4o-mini') may legitimately exist under multiple providers (openai vs
    -- azure, or two inference providers). Convention: store id namespaced as
    -- '{provider_id}/{name}' so it stays globally unique for URL lookups
    -- (/admin/models/{id}), but the real uniqueness guarantee is composite.
    CREATE TABLE IF NOT EXISTS models (
      id              TEXT NOT NULL,             -- conventionally '{provider}/{name}', e.g. 'openai/gpt-4o-mini'
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
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider_id, id)
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

    -- Upstream API keys per provider (multi-account support). One provider may
    -- own several keys (e.g. multiple OpenAI accounts); each is assigned to a
    -- route target so the engine can pick a specific account per target.
    -- credentials = encrypted blob {iv,ct,tag}, payload {apiKey:'sk-...'}.
    -- key_prefix holds a redacted prefix ('sk-ab12…') for display only.
    -- is_default: tepat SATU key per provider yg bertanda default — dipakai saat
    -- route target tidak menunjuk key spesifik (target.keyId NULL). Pengelolaan
    -- key lewat UI disatukan di sini; kolom providers.credentials lama dipertahankan
    -- utk backward-compat (migrasi memindahkannya ke sini sebagai default key).
    CREATE TABLE IF NOT EXISTS provider_keys (
      id            TEXT PRIMARY KEY,              -- UUID
      provider_id   TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      label         TEXT NOT NULL,                 -- 'Akun Kantor', 'Akun Pribadi'
      credentials   TEXT NOT NULL,                 -- encrypted blob {iv,ct,tag}
      key_prefix    TEXT NOT NULL DEFAULT '',      -- 'sk-ab12…' for display
      is_default    INTEGER NOT NULL DEFAULT 0,    -- 1 = key default provider ini
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id);

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
    -- FK composite ke models: referensi (provider_id, id) karena model identity
    -- kini composite — model_id saja tidak unik lintas provider.
    -- Kolom modality opsional utk override route.modality per-target — bila
    -- NULL, target memakai route.modality. Memungkinkan route campur target
    -- chat + responses (OpenAI Responses API) dgn failover antar modality.
    CREATE TABLE IF NOT EXISTS route_targets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL REFERENCES providers(id),
      model_id      TEXT NOT NULL,
      priority      INTEGER NOT NULL DEFAULT 0,  -- lower = tried first (fallback)
      weight        INTEGER NOT NULL DEFAULT 1,  -- relative (weighted strategy)
      enabled       INTEGER NOT NULL DEFAULT 1,
      modality      TEXT,  -- nullable: bila NULL → pakai route.modality (default)
      key_id        TEXT,  -- nullable: provider_keys(id). NULL → pakai provider.apiKey default
      FOREIGN KEY (provider_id, model_id) REFERENCES models(provider_id, id) ON DELETE CASCADE
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
      client_ip         TEXT,
      api_key_id        TEXT,                     -- FK ke api_keys(id), nullable utk request auth-open
      upstream_key_id   TEXT                      -- FK ke provider_keys(id), nullable utk statistik
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

  // ── migrasi: composite PK (provider_id, id) untuk models ──────────────
  // Skema lama memakai `id TEXT PRIMARY KEY` global unik, sehingga menambah
  // model dgn nama sama di provider berbeda (mis. openai/gpt-4o-mini vs
  // azure/gpt-4o-mini di provider inference lain) justru menimpa baris lama.
  // Skema baru menetapkan PK = (provider_id, id) supaya kombinasi tsb unik.
  migrateModelsCompositePk(db);

  // ── migrasi: composite FK route_targets → models ─────────────────────
  // Sebagai konsekuensi composite PK di models, FK lama route_targets
  // 'model_id REFERENCES models(id)' menjadi invalid (models.id tidak unik
  // sendiri). Rebuild route_targets dgn composite FK (provider_id, model_id).
  // Berjalan terpisah dari migrateModelsCompositePk supaya server production
  // yg SUDAH migrasi model (tapi route_targets FK-nya masih lama) juga ikut
  // ter-fix. Idempoten: jika FK sudah composite, skip.
  migrateRouteTargetsCompositeFk(db);

  // ── cleanup: hapus model dgn id korup (kosong / trailing slash) ──────
  // Bug normalisasi lama sempat menyimpan model dgn id '' atau 'exa_ai_1/'
  // (nama kosong setelah prefik provider) yg tidak bisa dihapus via URL admin
  // krn trailing slash ambigu. Cleanup ini menjalankan DELETE langsung. Aman
  // dijalankan berkali-kali (idempoten): jika tdk ada baris korup, no-op.
  cleanupCorruptModelIds(db);

  // ── migrasi: kolom modality di route_targets (per-target modality) ───
  // Memungkinkan override route.modality per target — mis. route chat biasa
  // tapi salah satu target (OpenAI) diakses via modality 'responses'. Bila NULL,
  // target memakai route.modality (behavior lama, backward compatible).
  addColumnIfMissing(db, 'route_targets', 'modality', 'TEXT');

  // ── migrasi: kolom api_key_id di requests (statistik per API key) ────
  // Catat API key mana yg dipakai tiap request supaya usage bisa dikelompokkan
  // per key (dashboard per-key). Nullable utk request auth-open (saat belum ada
  // api_keys terdaftar). Index utk query GROUP BY api_key_id yg cepat.
  addColumnIfMissing(db, 'requests', 'api_key_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id)');

  // ── migrasi: multi API key per provider ────────────────────────────────
  // (1) key_id di route_targets: assign key spesifik (provider_keys.id) ke tiap
  //     target. NULL = pakai provider.apiKey default (backward compatible).
  // (2) upstream_key_id di requests: catat key upstream mana yg melayani tiap
  //     request, utk statistik per upstream key. Index utk GROUP BY cepat.
  addColumnIfMissing(db, 'route_targets', 'key_id', 'TEXT');
  addColumnIfMissing(db, 'requests', 'upstream_key_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_upstream_key ON requests(upstream_key_id)');

  // ── migrasi: kolom is_default di provider_keys + pindah credentials lama ──
  // Pengelolaan key disatukan di provider_keys (UI hanya punya satu tempat). Key
  // default provider (yg lama disimpan di providers.credentials) dipindah otomatis
  // ke sini sebagai satu baris dgn is_default=1 — idempoten: skip provider yg
  // sudah punya default key di tabel provider_keys.
  addColumnIfMissing(db, 'provider_keys', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
  migrateLegacyCredentialsToProviderKeys(db);
}

/**
 * Pindah kredensial lama (providers.credentials) ke provider_keys sebagai key
 * default (is_default=1). Idempoten: provider yg sudah punya default key skip.
 * Provider dgn credentials kosong/korup dilewati (key default bisa dibuat manual).
 * `crypto.ts` dipakai via require-paksa setelah migrasi krn modul ini tidak boleh
 * bergantung balik ke crypto (agar urutan import aman); di sini kita pakai encryptJSON.
 */
function migrateLegacyCredentialsToProviderKeys(db: DB): void {
  // Ambil provider yg BELUM punya default key di provider_keys tapi punya row
  // credentials non-kosong di providers.
  const providers = db
    .prepare(
      `SELECT p.id, p.credentials
       FROM providers p
       WHERE p.credentials IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM provider_keys k WHERE k.provider_id = p.id AND k.is_default = 1)`,
    )
    .all() as { id: string; credentials: string }[];

  for (const p of providers) {
    try {
      const blob = JSON.parse(p.credentials) as { iv?: string; ct?: string; tag?: string };
      if (!blob.iv || !blob.ct || !blob.tag) continue; // korup, skip
      // Decrypt dgn blob lama utk dapat plaintext, lalu insert sbg default key.
      const decrypted = decryptJSON<{ apiKey?: string }>(blob as import('./crypto.js').EncryptedBlob);
      const value = decrypted.apiKey ?? '';
      if (!value) continue; // empty key (provider import dgn credentials blank), skip
      const id = `pkdef_${p.id}`;
      // Pakai id stabil (pkdef_<providerId>) supaya idempoten: run ulang tidak
      // buat duplikat. INSERT OR IGNORE cegah error bila sudah ada (mis. user
      // manual buat dgn id sama).
      db.prepare(
        `INSERT OR IGNORE INTO provider_keys (id, provider_id, label, credentials, key_prefix, is_default, enabled)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
      ).run(
        id,
        p.id,
        'Default',
        JSON.stringify(encryptJSON({ apiKey: value })),
        value.slice(0, 8) + (value.length > 8 ? '…' : ''),
      );
    } catch {
      // decrypt gagal (master key beda / blob korup) → skip, biar user set manual.
      continue;
    }
  }
}

/**
 * Pastikan tabel `models` memakai composite PK (provider_id, id).
 * Idempoten: jika PK sudah composite (berisi 'provider_id'), skip.
 *
 * SQLite tidak bisa mengubah PK tabel yg sudah ada secara inline, jadi kita
 * rebuild: buat models_new dgn skema baru → copy baris lama (id di-namespaced
 * '{provider}/{id_lama}' bila belum mengandung '/') → update route_targets →
 * drop+rename. `foreign_keys` harus dimatikan DI LUAR transaksi karena pragma
 * tsb diabaikan bila diubah di tengah transaksi aktif.
 */
function migrateModelsCompositePk(db: DB): void {
  const pk = db
    .prepare(`SELECT name FROM pragma_table_info('models') WHERE pk > 0 ORDER BY pk`)
    .all() as Array<{ name: string }>;
  const pkCols = pk.map((r) => r.name);
  // 'id' selalu ada; jika 'provider_id' juga bagian PK → sudah composite, selesai.
  if (pkCols.includes('provider_id')) return;

  // pragma foreign_keys TIDAK boleh diubah di tengah transaksi aktif. Karena
  // rebuild mengubah route_targets.model_id (yg di-FK ke models) sementara
  // tabel models lama masih ada dgn id lama, FK check akan gagal. Matikan
  // sebelum operasi, nyalakan lagi setelahnya.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE models_new (
        id              TEXT NOT NULL,
        provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        display_name    TEXT NOT NULL,
        modalities      TEXT NOT NULL DEFAULT '["text-to-text"]',
        context_window  INTEGER,
        max_output      INTEGER,
        input_price_per_1m  REAL,
        output_price_per_1m REAL,
        capabilities    TEXT NOT NULL DEFAULT '{}',
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (provider_id, id)
      );

      -- Copy baris lama. Konvensi id baru = '{provider}/{id_lama}'.
      -- Catatan: id dianggap "sudah namespaced" HANYA bila diawali persis
      -- '{provider_id}/'. Sekadar mengandung '/' (mis. 'deepseek/deepseek-v4-flash'
      -- milik provider 'novita') BUKAN bukti namespacing — keduanya harus
      -- diprefik ulang supaya tetap unik antar provider.
      INSERT INTO models_new (id, provider_id, display_name, modalities, context_window,
        max_output, input_price_per_1m, output_price_per_1m, capabilities, enabled,
        created_at, updated_at)
      SELECT
        CASE
          WHEN old_models.id LIKE provider_id || '/%' THEN old_models.id
          ELSE provider_id || '/' || old_models.id
        END,
        provider_id, display_name, modalities, context_window, max_output,
        input_price_per_1m, output_price_per_1m, capabilities, enabled,
        created_at, updated_at
      FROM models AS old_models;

      -- Perbarui route_targets.model_id agar konsisten dgn id model baru.
      -- route_targets punya kolom provider_id sendiri (target-level), jadi prefix
      -- diambil dari baris route_target itu sendiri. Aturan sama: hanya dianggap
      -- sudah namespaced bila diawali persis '{route_targets.provider_id}/'.
      UPDATE route_targets
      SET model_id = CASE
        WHEN route_targets.model_id LIKE route_targets.provider_id || '/%' THEN route_targets.model_id
        ELSE route_targets.provider_id || '/' || route_targets.model_id
      END;

      DROP TABLE models;
      ALTER TABLE models_new RENAME TO models;
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

      -- Rebuild route_targets: FK lama 'model_id REFERENCES models(id)' tidak
      -- valid lagi krn models.id tidak unik sendiri (PK composite). Buat ulang
      -- dgn composite FK (provider_id, model_id) → models(provider_id, id).
      CREATE TABLE route_targets_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        provider_id   TEXT NOT NULL REFERENCES providers(id),
        model_id      TEXT NOT NULL,
        priority      INTEGER NOT NULL DEFAULT 0,
        weight        INTEGER NOT NULL DEFAULT 1,
        enabled       INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (provider_id, model_id) REFERENCES models(provider_id, id) ON DELETE CASCADE
      );
      INSERT INTO route_targets_new (id, route_id, provider_id, model_id, priority, weight, enabled)
      SELECT id, route_id, provider_id, model_id, priority, weight, enabled FROM route_targets;
      DROP TABLE route_targets;
      ALTER TABLE route_targets_new RENAME TO route_targets;
      CREATE INDEX IF NOT EXISTS idx_route_targets_route ON route_targets(route_id);
    `);

    // Validasi integritas pasca-migrasi (FK sudah OFF, cek manual). Jika ada
    // route_targets yg model_id-nya tidak cocok dgn models baru, lempar error.
    const orphanCheck = db.prepare(`
      SELECT COUNT(*) AS c
      FROM route_targets rt
      LEFT JOIN models m ON m.id = rt.model_id AND m.provider_id = rt.provider_id
      WHERE m.id IS NULL
    `).get() as { c: number };
    if (orphanCheck.c > 0) {
      throw new Error(`migration produced ${orphanCheck.c} orphan route_targets; aborting`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Pastikan tabel `route_targets` memakai composite FK (provider_id, model_id)
 * → models(provider_id, id). Setelah models beralih ke composite PK, FK lama
 * 'model_id REFERENCES models(id)' jadi invalid krn models.id tidak unik
 * sendiri — insert/update route target akan gagal dgn "foreign key mismatch".
 *
 * Idempoten: deteksi via pragma_foreign_key_list. Skip bila FK composite sudah
 * ada. Berjalan terpisah dari migrateModelsCompositePk supaya server production
 * yg sudah migrasi model (tapi route_targets FK-nya belum di-rebuild) ikut
 * ter-fix saat pull kode baru ini.
 */
function migrateRouteTargetsCompositeFk(db: DB): void {
  const fks = db.prepare(`PRAGMA foreign_key_list('route_targets')`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  // FK composite ditandai dgn 2 baris (masing-masing kolom) utk tabel 'models'.
  const modelFkCols = fks.filter((f) => f.table === 'models');
  if (modelFkCols.length >= 2 && modelFkCols.some((f) => f.from === 'provider_id')) {
    return; // sudah composite FK, selesai
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE route_targets_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        provider_id   TEXT NOT NULL REFERENCES providers(id),
        model_id      TEXT NOT NULL,
        priority      INTEGER NOT NULL DEFAULT 0,
        weight        INTEGER NOT NULL DEFAULT 1,
        enabled       INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (provider_id, model_id) REFERENCES models(provider_id, id) ON DELETE CASCADE
      );

      INSERT INTO route_targets_new (id, route_id, provider_id, model_id, priority, weight, enabled)
      SELECT id, route_id, provider_id, model_id, priority, weight, enabled FROM route_targets;

      DROP TABLE route_targets;
      ALTER TABLE route_targets_new RENAME TO route_targets;
      CREATE INDEX IF NOT EXISTS idx_route_targets_route ON route_targets(route_id);
    `);

    // Validasi integritas: tiap route_target harus punya pasangan model-nya.
    const orphanCheck = db.prepare(`
      SELECT COUNT(*) AS c
      FROM route_targets rt
      LEFT JOIN models m ON m.id = rt.model_id AND m.provider_id = rt.provider_id
      WHERE m.id IS NULL
    `).get() as { c: number };
    if (orphanCheck.c > 0) {
      throw new Error(`route_targets FK rebuild left ${orphanCheck.c} orphans; aborting`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Hapus baris model dgn id korup: string kosong ('') atau berakhir '/' (nama
 * kosong setelah prefik provider). Bug normalisasi lama sempat membiarkan id
 * tsb tersimpan, dan baris itu tidak bisa dihapus via URL /admin/models/ krn
 * trailing slash ambigu (404). Cleanup ini menjalankan DELETE langsung.
 *
 * Idempoten: jika tidak ada baris korup, ini no-op. Aman dijalankan tiap boot.
 */
function cleanupCorruptModelIds(db: DB): void {
  // Hapus juga route_targets yg mereferensi model korup (ON DELETE CASCADE
  // seharusnya menangani ini, tapi FK enforcement bisa mati di kondisi tertentu).
  const result = db.prepare(`DELETE FROM models WHERE id = '' OR id LIKE '%/'`).run();
  if (result.changes > 0) {
    // Log tanpa throw — cleanup boleh diam-diam. Bila ingin terlihat, operator
    // bisa cek via `SELECT` sebelum dan sesudah start.
    console.log(`[migrate] removed ${result.changes} corrupt model(s) with empty/trailing-slash id`);
  }
}

/** Add a column only if it doesn't already exist (idempotent migration). */
function addColumnIfMissing(db: DB, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
  }
}
