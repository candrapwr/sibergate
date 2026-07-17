import { loadConfigFromDb } from './config.js';
import type { DB } from './db.js';
import type { SiberGateConfig } from './types.js';

/**
 * In-memory config store with hot-reload.
 *
 * The gateway loads config from SQLite once at boot, then caches it. After an
 * admin mutation (create/update/delete provider, model, route, or api key), the
 * store is reloaded so the change takes effect immediately — no restart needed.
 *
 * Keep a single shared instance for the gateway process.
 */
export class ConfigStore {
  private config: SiberGateConfig;
  private version = 0;

  constructor(private db: DB) {
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

  /** Reload config from the DB. Call after any admin write. */
  reload(): SiberGateConfig {
    this.config = loadConfigFromDb(this.db);
    this.version += 1;
    return this.config;
  }
}
