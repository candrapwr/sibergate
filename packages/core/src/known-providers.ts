/**
 * Built-in catalog of well-known LLM/AI providers (OpenAI-compatible APIs).
 *
 * Used by the "Import known providers" action in Settings: seeds providers +
 * their popular models with EMPTY credentials — the operator fills in their API
 * keys afterward. Prices/specs are reference values (per 1M tokens, USD) at
 * time of writing and are for cost-logging convenience only; verify on the
 * provider's pricing page for production billing.
 *
 * Every provider here exposes an OpenAI-compatible surface for at least chat.
 * Providers that also offer image/audio/embeddings get those endpoint mappings;
 * inference-style providers (DeepInfra, novita for image) use /v1/inference.
 */

export interface KnownModel {
  id: string;
  displayName: string;
  modalities?: string[];
  contextWindow?: number;
  maxOutput?: number;
  inputPricePer1m?: number;
  outputPricePer1m?: number;
  capabilities?: Record<string, boolean>;
}

export interface KnownProvider {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key';
  /** Env var name convention for the key (informational; key is blank until set). */
  apiKeyEnv: string;
  docsUrl?: string;
  /**
   * Per-modality endpoint templates. Providers that expose the standard
   * OpenAI-compatible surface omit this and inherit the default map below.
   * Custom inference providers (DeepInfra, novita image) override.
   */
  endpoints?: Record<string, string>;
  models: KnownModel[];
}

/**
 * Default endpoint map for OpenAI-compatible providers (chat + the standard
 * /v1/* surfaces). Applied when a provider doesn't declare its own `endpoints`.
 */
const OPENAI_ENDPOINTS: Record<string, string> = {
  chat: '/v1/chat/completions',
  image: '/v1/images/generations',
  speech: '/v1/audio/speech',
  transcribe: '/v1/audio/transcriptions',
  embed: '/v1/embeddings',
};

/** Resolve a provider's effective endpoints (declared or the OpenAI default). */
export function providerEndpoints(p: KnownProvider): Record<string, string> {
  return p.endpoints ?? OPENAI_ENDPOINTS;
}

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/docs/pricing',
    models: [
      // GPT-5.6 family (latest frontier)
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', modalities: ['text-to-text', 'vision'], contextWindow: 1050000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 30, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modalities: ['text-to-text', 'vision'], contextWindow: 1050000, maxOutput: 128000, inputPricePer1m: 2.5, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', modalities: ['text-to-text', 'vision'], contextWindow: 1050000, maxOutput: 128000, inputPricePer1m: 1, outputPricePer1m: 6, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // GPT-5.5 family
      { id: 'gpt-5.5', displayName: 'GPT-5.5', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 30, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 30, outputPricePer1m: 180, capabilities: { supports_streaming: true, supports_tools: true } },
      // GPT-5.4 family
      { id: 'gpt-5.4', displayName: 'GPT-5.4', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 2.5, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 0.75, outputPricePer1m: 4.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 nano', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 0.2, outputPricePer1m: 1.25, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 30, outputPricePer1m: 180, capabilities: { supports_streaming: true, supports_tools: true } },
      // GPT-5.2 family
      { id: 'gpt-5.2', displayName: 'GPT-5.2', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 1.75, outputPricePer1m: 14, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5.2-pro', displayName: 'GPT-5.2 Pro', modalities: ['text-to-text', 'vision'], contextWindow: 272000, maxOutput: 128000, inputPricePer1m: 21, outputPricePer1m: 168, capabilities: { supports_streaming: true, supports_tools: true } },
      // GPT-5 & GPT-5.1
      { id: 'gpt-5.1', displayName: 'GPT-5.1', modalities: ['text-to-text', 'vision'], contextWindow: 400000, maxOutput: 128000, inputPricePer1m: 1.25, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5', displayName: 'GPT-5', modalities: ['text-to-text', 'vision'], contextWindow: 400000, maxOutput: 128000, inputPricePer1m: 1.25, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5-mini', displayName: 'GPT-5 mini', modalities: ['text-to-text', 'vision'], contextWindow: 400000, maxOutput: 128000, inputPricePer1m: 0.25, outputPricePer1m: 2, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-5-nano', displayName: 'GPT-5 nano', modalities: ['text-to-text', 'vision'], contextWindow: 400000, maxOutput: 128000, inputPricePer1m: 0.05, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'gpt-5-pro', displayName: 'GPT-5 Pro', modalities: ['text-to-text', 'vision'], contextWindow: 400000, maxOutput: 128000, inputPricePer1m: 15, outputPricePer1m: 120, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // GPT-4.1 family
      { id: 'gpt-4.1', displayName: 'GPT-4.1', modalities: ['text-to-text', 'vision'], contextWindow: 1047576, maxOutput: 32768, inputPricePer1m: 2, outputPricePer1m: 8, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', modalities: ['text-to-text', 'vision'], contextWindow: 1047576, maxOutput: 32768, inputPricePer1m: 0.4, outputPricePer1m: 1.6, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-4.1-nano', displayName: 'GPT-4.1 nano', modalities: ['text-to-text', 'vision'], contextWindow: 1047576, maxOutput: 32768, inputPricePer1m: 0.1, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      // Reasoning: o-series
      { id: 'o3', displayName: 'o3', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 2, outputPricePer1m: 8, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'o3-pro', displayName: 'o3-pro', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 20, outputPricePer1m: 80, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'o4-mini', displayName: 'o4-mini', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 1.1, outputPricePer1m: 4.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'o3-mini', displayName: 'o3-mini', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 1.1, outputPricePer1m: 4.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'o1', displayName: 'o1', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 15, outputPricePer1m: 60, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'o1-pro', displayName: 'o1-pro', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 100000, inputPricePer1m: 150, outputPricePer1m: 600, capabilities: { supports_streaming: true, supports_tools: true } },
      // Legacy still-popular
      { id: 'gpt-4o', displayName: 'GPT-4o', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 16384, inputPricePer1m: 2.5, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o mini', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 16384, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // Image generation
      { id: 'gpt-image-2', displayName: 'GPT Image 2', modalities: ['image-generation'] },
      { id: 'gpt-image-1', displayName: 'GPT Image 1', modalities: ['image-generation'] },
      { id: 'dall-e-3', displayName: 'DALL·E 3', modalities: ['image-generation'] },
      { id: 'dall-e-2', displayName: 'DALL·E 2', modalities: ['image-generation'] },
      // Text-to-speech
      { id: 'gpt-4o-mini-tts', displayName: 'GPT-4o mini TTS', modalities: ['audio'] },
      { id: 'tts-1', displayName: 'TTS-1', modalities: ['audio'] },
      { id: 'tts-1-hd', displayName: 'TTS-1 HD', modalities: ['audio'] },
      // Realtime speech
      { id: 'gpt-realtime-2.1', displayName: 'GPT-Realtime 2.1', modalities: ['audio'] },
      { id: 'gpt-realtime-2', displayName: 'GPT-Realtime 2', modalities: ['audio'] },
      { id: 'gpt-realtime-1.5', displayName: 'GPT-Realtime 1.5', modalities: ['audio'] },
      // Transcription
      { id: 'gpt-4o-transcribe', displayName: 'GPT-4o Transcribe', modalities: ['audio-transcription'] },
      { id: 'gpt-4o-mini-transcribe', displayName: 'GPT-4o mini Transcribe', modalities: ['audio-transcription'] },
      { id: 'gpt-realtime-whisper', displayName: 'GPT-Realtime Whisper', modalities: ['audio-transcription'] },
      { id: 'whisper-1', displayName: 'Whisper', modalities: ['audio-transcription'] },
      // Embeddings
      { id: 'text-embedding-3-small', displayName: 'Embedding 3 Small', modalities: ['embeddings'] },
      { id: 'text-embedding-3-large', displayName: 'Embedding 3 Large', modalities: ['embeddings'] },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    authScheme: 'x-api-key',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    models: [
      { id: 'claude-fable-5', displayName: 'Claude Fable 5', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 10, outputPricePer1m: 50, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 25, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 25, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 25, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 5, outputPricePer1m: 25, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 64000, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 64000, inputPricePer1m: 1, outputPricePer1m: 5, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-3-7-sonnet-20250219', displayName: 'Claude 3.7 Sonnet', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 64000, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 8192, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 8192, inputPricePer1m: 0.8, outputPricePer1m: 4, capabilities: { supports_streaming: true, supports_tools: true } },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authScheme: 'bearer',
    apiKeyEnv: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    endpoints: {
      chat: '/v1beta/openai/chat/completions',
      embed: '/v1beta/openai/embeddings',
    },
    models: [
      { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 1.5, outputPricePer1m: 9, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', modalities: ['text-to-text', 'vision'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 1.25, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 0.3, outputPricePer1m: 2.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 1.25, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 0.3, outputPricePer1m: 2.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', modalities: ['text-to-text', 'vision'], contextWindow: 1048576, maxOutput: 65536, inputPricePer1m: 0.1, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      // Image generation (Nano Banana)
      { id: 'nano-banana-2', displayName: 'Nano Banana 2', modalities: ['image-generation'] },
      { id: 'nano-banana-pro', displayName: 'Nano Banana Pro', modalities: ['image-generation'] },
      { id: 'gemini-2.5-flash-image-preview', displayName: 'Gemini 2.5 Flash Image (nano banana)', modalities: ['image-generation'] },
      // Text-to-speech
      { id: 'gemini-3.1-flash-tts', displayName: 'Gemini 3.1 Flash TTS', modalities: ['audio'] },
      { id: 'gemini-2.5-flash-tts', displayName: 'Gemini 2.5 Flash TTS', modalities: ['audio'] },
      // Music generation
      { id: 'lyria-3-pro', displayName: 'Lyria 3 Pro', modalities: ['audio'] },
      // Embeddings
      { id: 'gemini-embedding-2', displayName: 'Gemini Embedding 2', modalities: ['embeddings'] },
      { id: 'text-embedding-004', displayName: 'Text Embedding 004', modalities: ['embeddings'] },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
    endpoints: { chat: '/v1/chat/completions' },
    models: [
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 0.14, outputPricePer1m: 0.28, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 0.435, outputPricePer1m: 0.87, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'deepseek-chat', displayName: 'DeepSeek V3 (chat, deprecated)', modalities: ['text-to-text'], contextWindow: 64000, maxOutput: 8192, inputPricePer1m: 0.27, outputPricePer1m: 1.1, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek R1 (reasoner, deprecated)', modalities: ['text-to-text'], contextWindow: 64000, maxOutput: 32768, inputPricePer1m: 0.55, outputPricePer1m: 2.19, capabilities: { supports_streaming: true, supports_tools: false } },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'GROQ_API_KEY',
    docsUrl: 'https://groq.com/pricing/',
    models: [
      { id: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B', modalities: ['text-to-text'], contextWindow: 131072, maxOutput: 65536, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'openai/gpt-oss-20b', displayName: 'GPT OSS 20B', modalities: ['text-to-text'], contextWindow: 131072, maxOutput: 65536, inputPricePer1m: 0.075, outputPricePer1m: 0.3, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', displayName: 'Llama 4 Scout', modalities: ['text-to-text', 'vision'], contextWindow: 131072, maxOutput: 8192, inputPricePer1m: 0.11, outputPricePer1m: 0.34, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 32768, inputPricePer1m: 0.59, outputPricePer1m: 0.79, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B Instant', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 131072, inputPricePer1m: 0.05, outputPricePer1m: 0.08, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'qwen/qwen3-32b', displayName: 'Qwen3 32B', modalities: ['text-to-text'], contextWindow: 131072, maxOutput: 40960, inputPricePer1m: 0.29, outputPricePer1m: 0.59, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'qwen/qwen3.6-27b', displayName: 'Qwen3.6 27B', modalities: ['text-to-text', 'vision'], contextWindow: 131072, maxOutput: 32768, inputPricePer1m: 0.6, outputPricePer1m: 3, capabilities: { supports_streaming: true } },
      { id: 'deepseek-r1-distill-llama-70b', displayName: 'DeepSeek R1 Distill 70B', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.75, outputPricePer1m: 0.99, capabilities: { supports_streaming: true } },
      { id: 'whisper-large-v3', displayName: 'Whisper Large v3', modalities: ['audio-transcription'] },
      { id: 'whisper-large-v3-turbo', displayName: 'Whisper Large v3 Turbo', modalities: ['audio-transcription'] },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'XAI_API_KEY',
    docsUrl: 'https://docs.x.ai/developers/models',
    models: [
      { id: 'grok-4.5', displayName: 'Grok 4.5', modalities: ['text-to-text', 'vision'], contextWindow: 500000, maxOutput: 128000, inputPricePer1m: 2, outputPricePer1m: 6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'grok-4.3', displayName: 'Grok 4.3', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 1.25, outputPricePer1m: 2.5, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'grok-4.20-0309-reasoning', displayName: 'Grok 4.20 Reasoning', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, inputPricePer1m: 1.25, outputPricePer1m: 2.5, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'grok-build-0.1', displayName: 'Grok Build 0.1', modalities: ['text-to-text'], contextWindow: 256000, inputPricePer1m: 1, outputPricePer1m: 2, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'grok-imagine-image', displayName: 'Grok Imagine', modalities: ['image-generation'] },
      { id: 'grok-imagine-video', displayName: 'Grok Imagine Video', modalities: ['video-generation'] },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'MISTRAL_API_KEY',
    docsUrl: 'https://docs.mistral.ai/products/pricing/',
    models: [
      { id: 'mistral-medium-latest', displayName: 'Mistral Medium 3.5', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 32768, inputPricePer1m: 1.5, outputPricePer1m: 7.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'mistral-large-latest', displayName: 'Mistral Large 3', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 8192, inputPricePer1m: 0.5, outputPricePer1m: 1.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'mistral-small-latest', displayName: 'Mistral Small 4', modalities: ['text-to-text'], contextWindow: 32000, maxOutput: 8192, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'pixtral-large-latest', displayName: 'Pixtral Large', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 32768, inputPricePer1m: 2, outputPricePer1m: 6, capabilities: { supports_streaming: true } },
      { id: 'pixtral-12b-2409', displayName: 'Pixtral 12B', modalities: ['text-to-text', 'vision'], contextWindow: 64000, maxOutput: 32768, inputPricePer1m: 0.15, outputPricePer1m: 0.15, capabilities: { supports_streaming: true } },
      { id: 'mistral-ocr-4-0', displayName: 'OCR 4', modalities: ['text-to-text'], capabilities: { supports_streaming: true } },
      { id: 'mistral-embed', displayName: 'Mistral Embed', modalities: ['embeddings'] },
      { id: 'voxtral-mini-tts-latest', displayName: 'Voxtral Mini TTS', modalities: ['audio'] },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/docs',
    models: [
      { id: 'openrouter/auto', displayName: 'Auto (cheapest)', modalities: ['text-to-text'], contextWindow: 128000, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini (via OR)', modalities: ['text-to-text', 'vision'], contextWindow: 128000, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'anthropic/claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6 (via OR)', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'google/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash (via OR)', modalities: ['text-to-text', 'vision', 'audio'], contextWindow: 1000000, capabilities: { supports_streaming: true } },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'TOGETHER_API_KEY',
    docsUrl: 'https://docs.together.ai/',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro', displayName: 'DeepSeek V4 Pro', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 1.74, outputPricePer1m: 3.48, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', displayName: 'DeepSeek V4 Flash', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 0.14, outputPricePer1m: 0.28, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', displayName: 'Llama 3.3 70B Turbo', modalities: ['text-to-text'], contextWindow: 128000, inputPricePer1m: 0.88, outputPricePer1m: 0.88, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/Llama-3.1-8B-Instruct-Turbo', displayName: 'Llama 3.1 8B Turbo', modalities: ['text-to-text'], contextWindow: 128000, inputPricePer1m: 0.18, outputPricePer1m: 0.18, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', displayName: 'Llama 4 Scout', modalities: ['text-to-text', 'vision'], contextWindow: 131072, inputPricePer1m: 0.27, outputPricePer1m: 0.85, capabilities: { supports_streaming: true } },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', displayName: 'Qwen 2.5 72B', modalities: ['text-to-text'], contextWindow: 32000, inputPricePer1m: 0.88, outputPricePer1m: 0.88, capabilities: { supports_streaming: true } },
      { id: 'black-forest-labs/FLUX.1-schnell', displayName: 'FLUX.1 schnell', modalities: ['image-generation'] },
      { id: 'black-forest-labs/FLUX.1-dev', displayName: 'FLUX.1 dev', modalities: ['image-generation'] },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    docsUrl: 'https://docs.fireworks.ai/',
    models: [
      { id: 'accounts/fireworks/models/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 1.74, outputPricePer1m: 3.48, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 384000, inputPricePer1m: 0.14, outputPricePer1m: 0.28, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/openai-gpt-oss-120b', displayName: 'GPT OSS 120B', modalities: ['text-to-text'], contextWindow: 131072, maxOutput: 65536, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/llama4-scout-instruct-basic', displayName: 'Llama 4 Scout', modalities: ['text-to-text', 'vision'], contextWindow: 131072, inputPricePer1m: 0.09, outputPricePer1m: 0.31, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', displayName: 'Llama 3.3 70B', modalities: ['text-to-text'], contextWindow: 128000, inputPricePer1m: 0.9, outputPricePer1m: 0.9, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/kimi-k2.7-code', displayName: 'Kimi K2.7 Code', modalities: ['text-to-text'], contextWindow: 262144, inputPricePer1m: 0.95, outputPricePer1m: 4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/glm-5.2', displayName: 'GLM 5.2', modalities: ['text-to-text'], contextWindow: 262144, inputPricePer1m: 1.4, outputPricePer1m: 4.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'accounts/fireworks/models/flux-1-dev', displayName: 'FLUX.1 dev', modalities: ['image-generation'] },
      { id: 'accounts/fireworks/models/whisper-v3', displayName: 'Whisper v3', modalities: ['audio-transcription'] },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/v2',
    authScheme: 'bearer',
    apiKeyEnv: 'COHERE_API_KEY',
    docsUrl: 'https://docs.cohere.com/docs/pricing',
    endpoints: { chat: '/v2/chat' },
    models: [
      { id: 'command-a-plus-05-2026', displayName: 'Command A+', modalities: ['text-to-text', 'vision'], contextWindow: 256000, maxOutput: 8000, inputPricePer1m: 3, outputPricePer1m: 12, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'command-a-03-2025', displayName: 'Command A', modalities: ['text-to-text'], contextWindow: 256000, maxOutput: 8000, inputPricePer1m: 2.5, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'command-r-plus-08-2024', displayName: 'Command R+', modalities: ['text-to-text'], contextWindow: 128000, inputPricePer1m: 2.5, outputPricePer1m: 10, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'command-r-08-2024', displayName: 'Command R', modalities: ['text-to-text'], contextWindow: 128000, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'embed-english-v3.0', displayName: 'Embed English v3', modalities: ['embeddings'] },
      { id: 'embed-multilingual-v3.0', displayName: 'Embed Multilingual v3', modalities: ['embeddings'] },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    authScheme: 'bearer',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    docsUrl: 'https://docs.perplexity.ai/',
    models: [
      { id: 'sonar-pro', displayName: 'Sonar Pro', modalities: ['text-to-text'], contextWindow: 200000, inputPricePer1m: 3, outputPricePer1m: 15, capabilities: { supports_streaming: true } },
      { id: 'sonar', displayName: 'Sonar', modalities: ['text-to-text'], contextWindow: 127072, inputPricePer1m: 1, outputPricePer1m: 1, capabilities: { supports_streaming: true } },
      { id: 'sonar-reasoning-pro', displayName: 'Sonar Reasoning Pro', modalities: ['text-to-text'], contextWindow: 127072, inputPricePer1m: 2, outputPricePer1m: 8, capabilities: { supports_streaming: true } },
    ],
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai',
    authScheme: 'bearer',
    apiKeyEnv: 'NOVITA_API_KEY',
    docsUrl: 'https://novita.ai/docs/api-reference/api-reference-overview',
    endpoints: {
      chat: '/v1/chat/completions',
      embed: '/v1/embeddings',
      image: '/v1/images/generations',
    },
    models: [
      // LLMs (OpenAI-compatible)
      { id: 'deepseek/deepseek-r1', displayName: 'DeepSeek R1 (via Novita)', modalities: ['text-to-text'], contextWindow: 64000, inputPricePer1m: 0.4, outputPricePer1m: 0.6, capabilities: { supports_streaming: true } },
      { id: 'deepseek/deepseek-v3-0324', displayName: 'DeepSeek V3 (via Novita)', modalities: ['text-to-text'], contextWindow: 64000, inputPricePer1m: 0.25, outputPricePer1m: 0.45, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/llama-3.3-70b-instruct', displayName: 'Llama 3.3 70B (via Novita)', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.34, outputPricePer1m: 0.39, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/llama-3.1-8b-instruct', displayName: 'Llama 3.1 8B (via Novita)', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.04, outputPricePer1m: 0.06, capabilities: { supports_streaming: true } },
      { id: 'qwen/qwen2.5-72b-instruct', displayName: 'Qwen 2.5 72B (via Novita)', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.3, outputPricePer1m: 0.45, capabilities: { supports_streaming: true } },
      // Image generation (SD/FLUX family)
      { id: 'flux1-schnell', displayName: 'FLUX.1 schnell (via Novita)', modalities: ['image-generation'] },
      { id: 'sdxl-1.0-base', displayName: 'SDXL 1.0', modalities: ['image-generation'] },
      { id: 'sd3.5-large', displayName: 'Stable Diffusion 3.5 Large', modalities: ['image-generation'] },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com',
    authScheme: 'bearer',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    docsUrl: 'https://docs.deepinfra.com/',
    endpoints: {
      chat: '/v1/openai/chat/completions',
      embed: '/v1/openai/embeddings',
      music: '/v1/inference/{model}',
      image: '/v1/inference/{model}',
    },
    models: [
      // Music generation (text-to-music) — ACE-Step
      { id: 'ACE-Step/acestep-v15-xl-sft', displayName: 'ACE-Step v1.5 (text-to-music)', modalities: ['audio'] },
      { id: 'ACE-Step/acestep-v15-xl-base', displayName: 'ACE-Step v1.5 Base', modalities: ['audio'] },
      // Chat models (served via openai-compat)
      { id: 'meta-llama/Llama-3.3-70B-Instruct', displayName: 'Llama 3.3 70B', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.27, outputPricePer1m: 0.85, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', displayName: 'Llama 4 Scout', modalities: ['text-to-text', 'vision'], contextWindow: 131072, inputPricePer1m: 0.15, outputPricePer1m: 0.6, capabilities: { supports_streaming: true } },
      { id: 'deepseek-ai/DeepSeek-R1', displayName: 'DeepSeek R1', modalities: ['text-to-text'], contextWindow: 131072, inputPricePer1m: 0.25, outputPricePer1m: 0.45, capabilities: { supports_streaming: true } },
      // Image generation (served via inference endpoint)
      { id: 'black-forest-labs/FLUX-1-dev', displayName: 'FLUX.1 dev', modalities: ['image-generation'] },
      { id: 'black-forest-labs/FLUX-1-schnell', displayName: 'FLUX.1 schnell', modalities: ['image-generation'] },
      { id: 'stabilityai/sd-3.5-large', displayName: 'Stable Diffusion 3.5 Large', modalities: ['image-generation'] },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'OLLAMA_API_KEY',
    docsUrl: 'https://ollama.com/blog/openai-compatibility',
    models: [
      { id: 'llama3.3', displayName: 'Llama 3.3', modalities: ['text-to-text'], contextWindow: 128000, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'qwen2.5', displayName: 'Qwen 2.5', modalities: ['text-to-text'], contextWindow: 32768, capabilities: { supports_streaming: true } },
      { id: 'llava', displayName: 'LLaVA', modalities: ['text-to-text', 'vision'], contextWindow: 4096, capabilities: { supports_streaming: true } },
      { id: 'nomic-embed-text', displayName: 'Nomic Embed Text', modalities: ['embeddings'] },
    ],
  },
  {
    id: 'vllm',
    name: 'vLLM (local)',
    baseUrl: 'http://localhost:8000/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'VLLM_API_KEY',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', displayName: 'Llama 3.3 70B', modalities: ['text-to-text'], capabilities: { supports_streaming: true, supports_tools: true } },
    ],
  },
  {
    id: 'zai',
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai',
    authScheme: 'bearer',
    apiKeyEnv: 'ZAI_API_KEY',
    docsUrl: 'https://docs.z.ai/guides/overview/pricing',
    endpoints: {
      chat: '/api/paas/v4/chat/completions',
    },
    models: [
      // Text models (flagship)
      { id: 'glm-5.2', displayName: 'GLM-5.2', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 128000, inputPricePer1m: 1.4, outputPricePer1m: 4.4, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-5.1', displayName: 'GLM-5.1', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 1.4, outputPricePer1m: 4.4, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-5', displayName: 'GLM-5', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 1, outputPricePer1m: 3.2, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-5-turbo', displayName: 'GLM-5-Turbo', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 1.2, outputPricePer1m: 4.0, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // Text models (general-purpose)
      { id: 'glm-4.7', displayName: 'GLM-4.7', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 0.6, outputPricePer1m: 2.2, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-4.7-flashx', displayName: 'GLM-4.7-FlashX', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 0.07, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.6', displayName: 'GLM-4.6', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 0.6, outputPricePer1m: 2.2, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-4.5', displayName: 'GLM-4.5', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0.6, outputPricePer1m: 2.2, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'glm-4.5-x', displayName: 'GLM-4.5-X', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 2.2, outputPricePer1m: 8.9, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.5-air', displayName: 'GLM-4.5-Air', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0.2, outputPricePer1m: 1.1, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.5-airx', displayName: 'GLM-4.5-AirX', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 1.1, outputPricePer1m: 4.5, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4-32b-0414-128k', displayName: 'GLM-4-32B-0414', modalities: ['text-to-text'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0.1, outputPricePer1m: 0.1, capabilities: { supports_streaming: true, supports_tools: true } },
      // Free text models
      { id: 'glm-4.7-flash', displayName: 'GLM-4.7-Flash (free)', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 0, outputPricePer1m: 0, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.5-flash', displayName: 'GLM-4.5-Flash (free)', modalities: ['text-to-text'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 0, outputPricePer1m: 0, capabilities: { supports_streaming: true, supports_tools: true } },
      // Vision models
      { id: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo', modalities: ['text-to-text', 'vision'], contextWindow: 200000, maxOutput: 128000, inputPricePer1m: 1.2, outputPricePer1m: 4.0, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.6v', displayName: 'GLM-4.6V', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0.3, outputPricePer1m: 0.9, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-ocr', displayName: 'GLM-OCR', modalities: ['text-to-text', 'vision'], inputPricePer1m: 0.03, outputPricePer1m: 0.03 },
      { id: 'glm-4.6v-flashx', displayName: 'GLM-4.6V-FlashX', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0.04, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.5v', displayName: 'GLM-4.5V', modalities: ['text-to-text', 'vision'], contextWindow: 64000, maxOutput: 64000, inputPricePer1m: 0.6, outputPricePer1m: 1.8, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'glm-4.6v-flash', displayName: 'GLM-4.6V-Flash (free)', modalities: ['text-to-text', 'vision'], contextWindow: 128000, maxOutput: 128000, inputPricePer1m: 0, outputPricePer1m: 0, capabilities: { supports_streaming: true } },
      // Image generation
      { id: 'glm-image', displayName: 'GLM-Image', modalities: ['image-generation'] },
      { id: 'cogview-4', displayName: 'CogView-4', modalities: ['image-generation'] },
      // Video generation
      { id: 'cogvideox-3', displayName: 'CogVideoX-3', modalities: ['video-generation'] },
      { id: 'viduq1-text', displayName: 'ViduQ1-Text', modalities: ['video-generation'] },
      { id: 'viduq1-image', displayName: 'ViduQ1-Image', modalities: ['video-generation'] },
      { id: 'viduq1-start-end', displayName: 'ViduQ1-Start-End', modalities: ['video-generation'] },
      { id: 'vidu2-image', displayName: 'Vidu2-Image', modalities: ['video-generation'] },
      { id: 'vidu2-start-end', displayName: 'Vidu2-Start-End', modalities: ['video-generation'] },
      { id: 'vidu2-reference', displayName: 'Vidu2-Reference', modalities: ['video-generation'] },
      // Audio (ASR)
      { id: 'glm-asr-2512', displayName: 'GLM-ASR-2512', modalities: ['audio-transcription'] },
    ],
  },
  {
    id: 'qwencloud',
    name: 'Qwen Cloud',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authScheme: 'bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    docsUrl: 'https://docs.qwencloud.com/developer-guides/getting-started/pricing',
    models: [
      // Qwen3.7 — flagship reasoning & coding
      { id: 'qwen3.7-max', displayName: 'Qwen3.7-Max', modalities: ['text-to-text'], contextWindow: 1000000, maxOutput: 65536, inputPricePer1m: 2.5, outputPricePer1m: 7.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'qwen3.7-plus', displayName: 'Qwen3.7-Plus', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 65536, inputPricePer1m: 0.4, outputPricePer1m: 1.6, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'qwen3.6-flash', displayName: 'Qwen3.6-Flash', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 65536, inputPricePer1m: 0.25, outputPricePer1m: 1.5, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'qwen3.6-max-preview', displayName: 'Qwen3.6-Max Preview', modalities: ['text-to-text'], contextWindow: 256000, maxOutput: 65536, inputPricePer1m: 1.3, outputPricePer1m: 7.8, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'qwen3.6-plus', displayName: 'Qwen3.6-Plus', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 65536, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // Qwen3.5 series
      { id: 'qwen3.5-plus', displayName: 'Qwen3.5-Plus', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 65536, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      { id: 'qwen3.5-flash', displayName: 'Qwen3.5-Flash', modalities: ['text-to-text', 'vision'], contextWindow: 1000000, maxOutput: 65536, capabilities: { supports_streaming: true, supports_tools: true, supports_json: true } },
      // Vision models
      { id: 'qwen3-vl-plus', displayName: 'Qwen3-VL-Plus', modalities: ['text-to-text', 'vision'], contextWindow: 256000, maxOutput: 65536, inputPricePer1m: 0.2, outputPricePer1m: 1.6, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'qwen3-vl-flash', displayName: 'Qwen3-VL-Flash', modalities: ['text-to-text', 'vision'], contextWindow: 256000, maxOutput: 65536, inputPricePer1m: 0.05, outputPricePer1m: 0.4, capabilities: { supports_streaming: true, supports_tools: true } },
      // Omni (speech-to-speech)
      { id: 'qwen3.5-omni-plus', displayName: 'Qwen3.5-Omni-Plus', modalities: ['text-to-text', 'vision', 'audio'], inputPricePer1m: 1.4, outputPricePer1m: 8.3, capabilities: { supports_streaming: true, supports_tools: true } },
      { id: 'qwen3.5-omni-flash', displayName: 'Qwen3.5-Omni-Flash', modalities: ['text-to-text', 'vision', 'audio'], inputPricePer1m: 0.4, outputPricePer1m: 2.2, capabilities: { supports_streaming: true, supports_tools: true } },
      // Image generation
      { id: 'qwen-image-2.0-pro', displayName: 'Qwen Image 2.0 Pro', modalities: ['image-generation'] },
      { id: 'qwen-image-2.0', displayName: 'Qwen Image 2.0', modalities: ['image-generation'] },
      { id: 'qwen-image-edit', displayName: 'Qwen Image Edit', modalities: ['image-generation'] },
      { id: 'wan2.6-t2i', displayName: 'Wan 2.6 T2I', modalities: ['image-generation'] },
      // Video generation
      { id: 'wan2.6-t2v', displayName: 'Wan 2.6 T2V', modalities: ['video-generation'] },
      { id: 'wan2.6-i2v', displayName: 'Wan 2.6 I2V', modalities: ['video-generation'] },
      { id: 'wan2.6-i2v-flash', displayName: 'Wan 2.6 I2V Flash', modalities: ['video-generation'] },
      // Text-to-speech
      { id: 'cosyvoice-v3-plus', displayName: 'CosyVoice v3 Plus', modalities: ['audio'] },
      { id: 'cosyvoice-v3-flash', displayName: 'CosyVoice v3 Flash', modalities: ['audio'] },
      { id: 'qwen3-tts-flash', displayName: 'Qwen3 TTS Flash', modalities: ['audio'] },
      // Speech-to-text
      { id: 'fun-asr', displayName: 'Fun ASR', modalities: ['audio-transcription'] },
      { id: 'qwen3-asr-flash', displayName: 'Qwen3 ASR Flash', modalities: ['audio-transcription'] },
      // Embeddings & Rerank
      { id: 'text-embedding-v4', displayName: 'Text Embedding v4', modalities: ['embeddings'] },
      { id: 'tongyi-embedding-vision-plus', displayName: 'Tongyi Embedding Vision Plus', modalities: ['embeddings'] },
      { id: 'tongyi-embedding-vision-flash', displayName: 'Tongyi Embedding Vision Flash', modalities: ['embeddings'] },
      { id: 'qwen3-rerank', displayName: 'Qwen3 Rerank', modalities: ['embeddings'] },
    ],
  },
];

/** Flatten: count of providers and models in the catalog. */
export const KNOWN_STATS = {
  providers: KNOWN_PROVIDERS.length,
  models: KNOWN_PROVIDERS.reduce((s, p) => s + p.models.length, 0),
};
