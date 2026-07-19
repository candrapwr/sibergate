import { getDb, type DB } from './db.js';
import { decryptJSON, type EncryptedBlob } from './crypto.js';
import type { ApiKey, Model, ModelModality, Provider, Route, RouteModality, RouteTarget, SiberGateConfig, Strategy } from './types.js';

/**
 * Load the full runtime config from SQLite (master data + routing engine).
 *
 * Provider credentials are decrypted here (transient, in-memory). JSON columns
 * (modalities, capabilities, headers, retry_on) are parsed. This is called once
 * at gateway startup.
 */
export function loadConfigFromDb(db?: DB): SiberGateConfig {
  const conn = db ?? getDb();

  const providers: Provider[] = conn
    .prepare('SELECT * FROM providers')
    .all()
    .map((row: any) => {
      let apiKey = '';
      try {
        const creds = decryptJSON<{ apiKey?: string }>(JSON.parse(row.credentials) as EncryptedBlob);
        apiKey = creds.apiKey ?? '';
      } catch {
        // Decryption failed — provider will simply 401 upstream.
        apiKey = '';
      }
      return {
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        authScheme: row.auth_scheme as 'bearer' | 'x-api-key',
        apiKey,
        headers: safeJsonParse(row.headers, {}),
        timeoutMs: row.timeout_ms ?? undefined,
        enabled: row.enabled === 1,
        // Per-modality endpoint templates (e.g. {chat, image, music}). Missing
        // keys mean the provider doesn't serve that modality.
        endpoints: safeJsonParse(row.endpoints ?? '{}', {}) as Record<string, string>,
      };
    });

  const models: Model[] = conn
    .prepare('SELECT * FROM models')
    .all()
    .map((row: any) => ({
      id: row.id,
      providerId: row.provider_id,
      displayName: row.display_name,
      modalities: safeJsonParse<ModelModality[]>(row.modalities, ['text-to-text']),
      contextWindow: row.context_window ?? undefined,
      maxOutput: row.max_output ?? undefined,
      inputPricePer1m: row.input_price_per_1m ?? undefined,
      outputPricePer1m: row.output_price_per_1m ?? undefined,
      capabilities: safeJsonParse(row.capabilities, {}),
      enabled: row.enabled === 1,
    }));

  const apiKeys: ApiKey[] = conn
    .prepare('SELECT * FROM api_keys')
    .all()
    .map((row: any) => ({
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      enabled: row.enabled === 1,
    }));

  const routeRows = conn.prepare('SELECT * FROM routes').all() as any[];
  const targetRows = conn.prepare('SELECT * FROM route_targets').all() as any[];

  const routes: Route[] = routeRows.map((r) => ({
    id: r.id,
    name: r.name,
    modality: (r.modality ?? 'chat') as RouteModality,
    strategy: r.strategy as Strategy,
    timeoutMs: r.timeout_ms,
    maxRetries: r.max_retries ?? undefined,
    retryOn: safeJsonParse<number[]>(r.retry_on, [429, 500, 502, 503, 504]),
    enabled: r.enabled === 1,
    targets: targetRows
      .filter((t) => t.route_id === r.id)
      .map((t) => ({
        providerId: t.provider_id,
        modelId: t.model_id,
        priority: t.priority,
        weight: t.weight,
        enabled: t.enabled === 1,
        // modality override per-target; null = pakai route.modality (default).
        modality: (t.modality as RouteTarget['modality']) ?? null,
      })),
  }));

  return { providers, models, routes, apiKeys };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Look up a route by id from a loaded config. */
export function getRoute(config: SiberGateConfig, id: string): Route {
  const r = config.routes.find((x) => x.id === id && x.enabled);
  if (!r) throw new Error(`Unknown or disabled route: ${id}`);
  return r;
}
