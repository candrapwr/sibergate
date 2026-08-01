import { createHash } from 'node:crypto';

/**
 * Reasoning-content preservation — the DeepSeek analogue of Gemini's
 * `thought_signature` cache (see signatures.ts).
 *
 * DeepSeek thinking-mode models (deepseek-v4-pro, deepseek-reasoner / R1, …)
 * return a non-standard `reasoning_content` field on the assistant message.
 * That field **must** be sent back on the next turn of the same conversation,
 * otherwise DeepSeek rejects the request with:
 *   400 "The `reasoning_content` in the thinking mode must be passed back."
 *
 * Unlike Gemini signatures (which attach to a tool_call with a stable `id`),
 * `reasoning_content` attaches to the assistant **message**, and an OpenAI
 * assistant message has no native stable id. We therefore key the cache by a
 * hash of the message `content`: the same content hash will match when the
 * client echoes the assistant message back in turn 2.
 *
 * Lifecycle: on the upstream RESPONSE we store `reasoning_content` keyed by
 * hash(content), then STRIP it so the client gets pure OpenAI format. On the
 * next REQUEST we walk the assistant messages, and for any whose content hash
 * is in the cache we re-attach `reasoning_content` before forwarding upstream.
 *
 * Cache: in-memory Map, 1h TTL, 5000-entry cap, LRU-ish eviction. Reset on
 * process restart (same trade-off as the Gemini signature cache).
 */

const TTL_MS = 3600_000;
const MAX_ENTRIES = 5000;

interface CachedReasoning {
  reasoning: string;
  providerId: string;
  createdAt: number;
}

const cache = new Map<string, CachedReasoning>();

/**
 * Deterministic key for a message. We hash the (string) `content` of the
 * assistant message — the field a client reliably echoes back. Falling back to
 * a hash of `JSON.stringify(content)` keeps it stable for array content too.
 */
export function reasoningKeyFor(content: unknown): string | null {
  if (content == null) return null;
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  if (!str) return null;
  return createHash('sha256').update(str).digest('hex');
}

/** Store reasoning_content for a message identified by its content hash. */
export function storeReasoning(key: string, reasoning: string, providerId: string): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { reasoning, providerId, createdAt: Date.now() });
}

/** Look up reasoning_content by key (null if missing/expired). LRU re-insert on hit. */
export function getReasoning(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.reasoning;
}

/** @internal snapshot for tests/monitoring */
export function reasoningCacheSize(): number {
  return cache.size;
}
