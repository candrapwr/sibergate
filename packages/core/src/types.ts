/**
 * SiberGate runtime types.
 *
 * These represent the in-memory shape after loading from SQLite (providers
 * decrypted, JSON columns parsed). The DB layer (db.ts) owns the on-disk
 * schema; these types model what the routing engine consumes.
 */

/** A provider with decrypted credentials, ready to call upstream. */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key';
  /** Decrypted API key (held in memory only at runtime). */
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  enabled: boolean;
  /**
   * Per-modality upstream endpoint templates. Keys are RouteModality values.
   * A provider only serves a modality if this map has that key.
   *   { "chat":"/v1/chat/completions", "image":"/v1/images/generations",
   *     "speech":"/v1/audio/speech", "transcribe":"/v1/audio/transcriptions",
   *     "embed":"/v1/embeddings", "music":"/v1/inference/{model}" }
   * `{model}` is substituted with the target's model id at call time.
   */
  endpoints: Partial<Record<RouteModality, string>>;
}

/** The KIND of gateway request / route (which adapter handles it). */
export type RouteModality = 'chat' | 'image' | 'speech' | 'transcribe' | 'embed' | 'music';

/** What a model can do (capabilities). JSON array stored in DB. */
export type ModelModality =
  | 'text-to-text'
  | 'vision'
  | 'image-generation'
  | 'audio'
  | 'audio-transcription'
  | 'embeddings';

/** A model definition from the directory. */
export interface Model {
  id: string;
  providerId: string;
  displayName: string;
  modalities: ModelModality[];
  contextWindow?: number;
  maxOutput?: number;
  inputPricePer1m?: number;
  outputPricePer1m?: number;
  capabilities: Record<string, boolean>;
  enabled: boolean;
}

/** Routing strategies. */
export type Strategy = 'fallback' | 'fastest' | 'weighted';

/** A concrete (provider, model) target a route can dispatch to. */
export interface RouteTarget {
  providerId: string;
  modelId: string;
  priority: number;
  weight: number;
  enabled: boolean;
}

/** A virtual client-facing endpoint. */
export interface Route {
  id: string;
  name: string;
  /** Which adapter handles this route's requests. */
  modality: RouteModality;
  strategy: Strategy;
  timeoutMs: number;
  maxRetries?: number;
  retryOn: number[];
  enabled: boolean;
  targets: RouteTarget[];
}

/** A client API key. */
export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  enabled: boolean;
}

/** The full runtime config loaded from SQLite. */
export interface SiberGateConfig {
  providers: Provider[];
  models: Model[];
  routes: Route[];
  apiKeys: ApiKey[];
}
