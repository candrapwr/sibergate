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
  /**
   * Upstream wire protocol.
   *   'openai' (default) = REST provider; baseUrl + endpoints map + authScheme
   *                describe a plain HTTP API (OpenAI-compatible or vendor-dialect
   *                via the adapters).
   *   'mcp'      = Model Context Protocol server (Streamable HTTP). baseUrl is
   *                the MCP endpoint (e.g. https://kling.ai/mcp); auth is either
   *                a static key (authScheme) or OAuth 2.1 (mcp_oauth table).
   *                Tools are discovered via tools/list and imported as models.
   */
  protocol?: 'openai' | 'mcp';
  /** Opsi khusus provider MCP. JSON column mcp_options di DB. */
  mcpOptions?: McpProviderOptions | null;
  /**
   * How the provider's key is attached to upstream requests.
   *   bearer    → Authorization: Bearer <key>     (default; OpenAI-style)
   *   x-api-key → x-api-key: <key>                (Anthropic-style)
   *   query     → ?api_key=<key> appended to URL  (some REST APIs)
   *   basic     → Authorization: Basic <base64(user:key)>  (HTTP Basic)
   *   none      → no auth header (public upstreams; apiKey optional)
   */
  authScheme: 'bearer' | 'x-api-key' | 'query' | 'basic' | 'none';
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

/** Konfigurasi tambahan untuk provider protocol='mcp'. */
export interface McpProviderOptions {
  /**
   * Mode penanganan vendor. 'generic' (default) = perilaku standar via
   * auto-deteksi. 'kling' = penanganan spesifik Kling AI (default poll tool
   * query_tasks/generation_id; titik ekstensi utk quirk Kling berikutnya).
   * Server MCP lain yg butuh perlakuan beda akan mendapat mode baru.
   */
  mode?: 'generic' | 'kling';
  /**
   * Nama tool untuk mem-poll task async (generation_id → status + URL hasil).
   * Auto-deteksi saat sync tools (mis. 'query_tasks' di Kling); bisa dioverride.
   */
  pollTool?: string;
  /** Nama argumen task-id tool polling (default: auto-detect dari inputSchema). */
  pollToolArg?: string;
}

/** Metadata sebuah tool MCP — disimpan di models.tool_meta (JSON). */
export interface McpToolMeta {
  mcpTool: true;
  /** Nama tool asli di server MCP (model id = '{providerId}/{toolName}'). */
  toolName: string;
  /**
   * Varian model vendor (mis. 'kling-v2-master') — model id menjadi
   * '{providerId}/{toolName}@{variant}'. Di-inject sebagai argumen `model`
   * tool saat dispatch. Pada model DASAR hasil sync who_am_i (Kling), ini
   * berisi defaultModel tool tsb (server mewajibkan parameter model).
   */
  modelVariant?: string;
  /** Label vendor utk varian (alias dari who_am_i, mis. 'kling3.0'). */
  modelLabel?: string;
  /** JSON Schema argumen tool (dari tools/list atau sintetis who_am_i). */
  inputSchema?: Record<string, unknown>;
  /**
   * Envelope pemanggilan tools/call (dari schema tools/list asli):
   * 'pairs' = Kling (model top-level + arguments[{name,value}] + inputs[]),
   * 'flat'  = argumen sebagai properti langsung (default).
   */
  argEnvelope?: 'flat' | 'pairs';
  /** Slot media model (image_1, first_image, ...) utk envelope 'pairs'. */
  inputSlots?: string[];
  /** Anotasi MCP (title, readOnlyHint, destructiveHint, ...). */
  annotations?: Record<string, unknown>;
  /** Tool polling yang dipakai bila tool ini mengembalikan task async. */
  pollTool?: string;
}

/** The KIND of gateway request / route (which adapter handles it). */
export type RouteModality =
  | 'chat'
  | 'image'
  | 'video'
  | 'mcp'
  | 'speech'
  | 'transcribe'
  | 'embed'
  | 'music'
  | 'generic'
  | 'responses'
  | 'tools-text'
  | 'tools-text-stream'
  | 'tools-text-nonstream';

/** What a model can do (capabilities). JSON array stored in DB. */
export type ModelModality =
  | 'text-to-text'
  | 'vision'
  | 'image-generation'
  | 'video-generation'
  | 'audio'
  | 'audio-transcription'
  | 'embeddings'
  | 'api'; // non-LLM REST API target (search, webhook, microservice) — paired with the generic route modality

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
  /** Untuk model hasil import tool MCP: schema + anotasi tool. Null = model biasa. */
  toolMeta?: McpToolMeta | null;
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
  /**
   * Override modality per-target (opsional). Bila null/undefined, target
   * memakai route.modality. Contoh: route chat biasa, tapi salah satu target
   * (OpenAI) diakses via modality 'responses' — gateway convert dua arah.
   */
  modality?: RouteModality | null;
  /**
   * Upstream API key to use for this target (opsional). Merujuk ke
   * ProviderKey.id — memungkinkan satu provider memakai beberapa akun/key,
   * masing-masing di-assign ke target berbeda (mis. load-balance antar akun).
   * Bila null/undefined → pakai provider.apiKey default (kolom credentials lama).
   */
  keyId?: string | null;
  /**
   * Body mapping mode per-target (opsional). 'verbatim' (default bila
   * null/undefined) = request/response diteruskan apa adanya — perilaku lama.
   * 'auto' = gateway menerjemahkan body request ke format native target
   * (mis. OpenAI images → Kling model_name/aspect_ratio atau Qwen
   * input.messages) DAN meng-convert response balik ke format OpenAI.
   * Dibaca per-target saat dispatch, jadi failover antar target dgn mode
   * berbeda aman (persis pola modality override).
   */
  mapping?: 'verbatim' | 'auto' | null;
}

/**
 * An upstream API key milik sebuah provider (multi-account support).
 * Plaintext (value) dipegang di memori saat runtime untuk injeksi ke upstream.
 */
export interface ProviderKey {
  id: string;
  providerId: string;
  /** Decrypted plaintext key (held in memory only; never returned by admin API). */
  value: string;
  /** Display label, e.g. "Akun Kantor". */
  label: string;
  enabled: boolean;
  /** Tepat satu key per provider bertanda default — dipakai saat target.keyId NULL. */
  isDefault: boolean;
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

/** Status video job (OpenAI Sora-style states). */
export type VideoJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

/**
 * Satu job generasi video (modality 'video', OpenAI-style /v1/videos).
 * Dibuat saat POST /v1/videos; task async upstream dilacak via task_ref
 * (generation_id di MCP Kling) dan di-poll lewat tool polling saat GET.
 */
export interface VideoJob {
  id: string;
  routeId: string;
  providerId: string;
  /** Model id namespaced (provider/tool) — tool generasi yang dipakai. */
  modelId: string;
  /** Tool polling (mis. query_tasks) untuk task async; null bila sync. */
  pollTool: string | null;
  /** Ref task upstream (generation_id / task_id); null bila sync selesai. */
  taskRef: string | null;
  status: VideoJobStatus;
  /** 0-100, best-effort dari status upstream. */
  progress: number;
  /** Respons mentah tools/call terakhir (JSON) — audit + ekstraksi URL. */
  result: Record<string, unknown> | null;
  /** URL aset video final (dari works[].url dsb.) setelah completed. */
  videoUrls: string[];
  error: string | null;
  /** API key pembuat job — utk access control saat GET/DELETE. */
  apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The full runtime config loaded from SQLite. */
export interface SiberGateConfig {
  providers: Provider[];
  models: Model[];
  routes: Route[];
  apiKeys: ApiKey[];
  /** Upstream API keys per provider (multi-account support). */
  providerKeys: ProviderKey[];
}
