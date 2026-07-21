/**
 * In-memory latency tracker (exponential moving average).
 *
 * Used by the 'fastest' strategy to pick the target with the lowest recent
 * latency. No persistence needed — window resets on restart, which is fine
 * because latency is about current conditions, not history.
 *
 * Thread-safe by virtue of JS single-threadedness; updates are tiny.
 */

const ALPHA = 0.3; // EMA smoothing: weight on the newest sample
const DECAY_INTERVAL_MS = 60_000;
const DECAY_FACTOR = 0.95; // gently decay stale entries toward the mean

const ema = new Map<string, number>(); // key: `${provider}:${model}` -> ms
const samples = new Map<string, number>(); // sample count
let lastDecay = Date.now();

/** Record a latency sample for a provider:model target. */
export function recordLatency(provider: string, model: string, ms: number): void {
  maybeDecay();
  const key = `${provider}:${model}`;
  const prev = ema.get(key);
  ema.set(key, prev === undefined ? ms : prev * (1 - ALPHA) + ms * ALPHA);
  samples.set(key, (samples.get(key) ?? 0) + 1);
}

/** Record a failure: penalize the target's EMA by a fixed multiplier. */
export function recordFailure(provider: string, model: string): void {
  maybeDecay();
  const key = `${provider}:${model}`;
  const prev = ema.get(key);
  // Treat a failure like a very slow successful request, so 'fastest' backs off.
  const penalty = Math.max(prev ?? 1000, 5000);
  ema.set(key, prev === undefined ? penalty : prev * (1 - ALPHA) + penalty * ALPHA);
}

/** Get the current latency estimate for a target (ms). Unknown = high default. */
export function getLatency(provider: string, model: string): number {
  return ema.get(`${provider}:${model}`) ?? 999_999;
}

/** Whether this target has been observed before (success or failure). */
export function hasLatencyEstimate(provider: string, model: string): boolean {
  return ema.has(`${provider}:${model}`);
}

/**
 * Reset semua estimasi latency in-memory (EMA + sample count). Dipakai oleh
 * tombol "Reset stats" di Settings — berguna setelah perubahan besar (mis.
 * ganti provider, migrasi) supaya strategi 'fastest' tidak memakai data lama
 * yg tidak lagi relevan. Window reset juga terjadi otomatis saat restart.
 */
export function resetLatency(): { cleared: number } {
  const cleared = ema.size;
  ema.clear();
  samples.clear();
  lastDecay = Date.now();
  return { cleared };
}

/** Slowly decay estimates so old data doesn't dominate. */
function maybeDecay(): void {
  const now = Date.now();
  if (now - lastDecay < DECAY_INTERVAL_MS) return;
  lastDecay = now;
  for (const [key, val] of ema) {
    ema.set(key, val * DECAY_FACTOR);
  }
}
