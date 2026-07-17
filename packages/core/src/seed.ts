import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from './env.js';
import { getDb } from './db.js';
import { encryptJSON } from './crypto.js';
import { generateApiKey } from './api-key.js';

/**
 * Seed SQLite master data from a JSON file (sibergate.config.json).
 *
 * This is the ONLY place plaintext provider keys appear: they're read from the
 * seed file (or env), encrypted with AES-256-GCM, and stored. The seed file is
 * safe to keep locally but should not be committed with real keys.
 *
 * Idempotent: existing rows are upserted (re-seeding updates creds/prices).
 * Prints a new client API key (shown once) if none exist.
 */

interface SeedFile {
  providers: Array<{
    id: string;
    name?: string;
    baseUrl: string;
    authScheme?: 'bearer' | 'x-api-key';
    apiKey?: string; // plaintext, read here only
    apiKeyEnv?: string; // or read from env
    headers?: Record<string, string>;
    timeoutMs?: number;
    /** Per-modality endpoint templates, e.g. {chat, image, music}. */
    endpoints?: Record<string, string>;
  }>;
  models: Array<{
    id: string;
    provider: string;
    displayName?: string;
    modalities?: string[];
    contextWindow?: number;
    maxOutput?: number;
    inputPricePer1m?: number;
    outputPricePer1m?: number;
    capabilities?: Record<string, boolean>;
  }>;
  routes: Array<{
    id: string;
    name?: string;
    /** chat | image | speech | transcribe | embed | music. Defaults to 'chat'. */
    modality?: 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music';
    strategy?: 'fallback' | 'fastest' | 'weighted';
    timeoutMs?: number;
    maxRetries?: number;
    retryOn?: number[];
    targets: Array<{ provider: string; model: string; priority?: number; weight?: number }>;
  }>;
}

export async function seed(configPath?: string): Promise<void> {
  await loadDotEnv();
  const path = configPath ?? process.env.SIBERGATE_CONFIG ?? 'sibergate.config.json';
  const raw = readFileSync(resolve(process.cwd(), path), 'utf8');
  const data = JSON.parse(raw) as SeedFile;
  const db = getDb();

  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, name, base_url, auth_scheme, credentials, endpoints, headers, timeout_ms, enabled)
    VALUES (@id, @name, @baseUrl, @authScheme, @credentials, @endpoints, @headers, @timeoutMs, 1)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, base_url=@baseUrl, auth_scheme=@authScheme, credentials=@credentials,
      endpoints=@endpoints, headers=@headers, timeout_ms=@timeoutMs, updated_at=datetime('now')
  `);
  const upsertModel = db.prepare(`
    INSERT INTO models (id, provider_id, display_name, modalities, context_window, max_output,
      input_price_per_1m, output_price_per_1m, capabilities, enabled)
    VALUES (@id, @providerId, @displayName, @modalities, @contextWindow, @maxOutput,
      @inputPrice, @outputPrice, @capabilities, 1)
    ON CONFLICT(id) DO UPDATE SET
      provider_id=@providerId, display_name=@displayName, modalities=@modalities,
      context_window=@contextWindow, max_output=@maxOutput, input_price_per_1m=@inputPrice,
      output_price_per_1m=@outputPrice, capabilities=@capabilities, updated_at=datetime('now')
  `);
  const upsertRoute = db.prepare(`
    INSERT INTO routes (id, name, modality, strategy, timeout_ms, max_retries, retry_on, enabled)
    VALUES (@id, @name, @modality, @strategy, @timeoutMs, @maxRetries, @retryOn, 1)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, modality=@modality, strategy=@strategy, timeout_ms=@timeoutMs, max_retries=@maxRetries,
      retry_on=@retryOn, updated_at=datetime('now')
  `);
  const clearTargets = db.prepare('DELETE FROM route_targets WHERE route_id = ?');
  const insertTarget = db.prepare(`
    INSERT INTO route_targets (route_id, provider_id, model_id, priority, weight, enabled)
    VALUES (@routeId, @providerId, @modelId, @priority, @weight, 1)
  `);
  const insertApiKey = db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, enabled)
    VALUES (@id, @name, @keyHash, @keyPrefix, 1)
  `);
  const keyCount = (db.prepare('SELECT COUNT(*) as c FROM api_keys').get() as any).c;

  const tx = db.transaction(() => {
    // Providers
    for (const p of data.providers) {
      const apiKey = p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] ?? '' : '');
      upsertProvider.run({
        id: p.id,
        name: p.name ?? p.id,
        baseUrl: p.baseUrl,
        authScheme: p.authScheme ?? 'bearer',
        credentials: JSON.stringify(encryptJSON({ apiKey })),
        endpoints: JSON.stringify(p.endpoints ?? { chat: '/v1/chat/completions' }),
        headers: JSON.stringify(p.headers ?? {}),
        timeoutMs: p.timeoutMs ?? null,
      });
      console.log(`  ✓ provider: ${p.id}`);
    }
    // Models
    for (const m of data.models) {
      upsertModel.run({
        id: m.id,
        providerId: m.provider,
        displayName: m.displayName ?? m.id,
        modalities: JSON.stringify(m.modalities ?? ['text-to-text']),
        contextWindow: m.contextWindow ?? null,
        maxOutput: m.maxOutput ?? null,
        inputPrice: m.inputPricePer1m ?? null,
        outputPrice: m.outputPricePer1m ?? null,
        capabilities: JSON.stringify(m.capabilities ?? {}),
      });
      console.log(`  ✓ model: ${m.id} (${m.provider})`);
    }
    // Routes + targets
    for (const r of data.routes) {
      upsertRoute.run({
        id: r.id,
        name: r.name ?? r.id,
        modality: r.modality ?? 'chat',
        strategy: r.strategy ?? 'fallback',
        timeoutMs: r.timeoutMs ?? 30_000,
        maxRetries: r.maxRetries ?? null,
        retryOn: JSON.stringify(r.retryOn ?? [429, 500, 502, 503, 504, 401, 403]),
      });
      clearTargets.run(r.id);
      for (const t of r.targets) {
        insertTarget.run({
          routeId: r.id,
          providerId: t.provider,
          modelId: t.model,
          priority: t.priority ?? 0,
          weight: t.weight ?? 1,
        });
      }
      console.log(`  ✓ route: ${r.id} (${r.strategy ?? 'fallback'}, ${r.targets.length} targets)`);
    }
  });
  tx();

  // Issue a client API key if none exist.
  if (keyCount === 0) {
    const k = generateApiKey();
    insertApiKey.run({
      id: randomUUID(),
      name: 'default',
      keyHash: k.hash,
      keyPrefix: k.prefix,
    });
    console.log('\n──────────────────────────────────────────');
    console.log(' ✅ Seed complete. Client API key (shown ONCE):');
    console.log('──────────────────────────────────────────');
    console.log(`   ${k.plaintext}`);
    console.log('──────────────────────────────────────────');
  } else {
    console.log('\n✅ Seed complete (API key already exists, skipping key creation).');
  }
}
