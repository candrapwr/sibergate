import { loadConfigFromDb } from './config.js';
import { getDb, type DB } from './db.js';
import type { SiberGateConfig } from './types.js';

/**
 * In-memory config store with hot-reload.
 *
 * The gateway loads config from SQLite once at boot, then caches it. After an
 * admin mutation (create/update/delete provider, model, route, or api key), the
 * store is reloaded so the change takes effect immediately — no restart needed.
 *
 * reload() re-acquires the DB via getDb() rather than caching the handle. This
 * matters for restoreBackup, which closes + re-opens the DB: if we cached the
 * old handle, every query after restore would hit a closed DB and crash.
 *
 * Keep a single shared instance for the gateway process.
 */
export class ConfigStore {
  private config: SiberGateConfig;
  private version = 0;
  private readonly initialDb: DB;

  constructor(db: DB) {
    this.initialDb = db;
    this.config = loadConfigFromDb(db);
  }

  /** Current cached config. */
  get(): SiberGateConfig {
    return this.config;
  }

  /** Monotonic version — bumps on every reload (useful for cache invalidation). */
  getVersion(): number {
    return this.version;
  }

  /** Reload config from the DB. Call after any admin write.
   *  Re-acquires the DB handle via getDb() so it survives a restore (which
   *  closes + reopens the singleton connection). */
  reload(): SiberGateConfig {
    // getDb() returns the live singleton; after restoreBackup it's a fresh
    // connection to the restored file. Fall back to the initial handle only if
    // the singleton was never reset (defensive — shouldn't happen in practice).
    const db = getDb() ?? this.initialDb;
    this.config = loadConfigFromDb(db);
    this.version += 1;
    return this.config;
  }
}
