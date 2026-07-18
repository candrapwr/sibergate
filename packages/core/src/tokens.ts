/**
 * Fast token estimator (~4 chars ≈ 1 token).
 *
 * Accurate within ±15% — good enough for cost logging. The function signature
 * is stable so an exact tokenizer can drop in later if precise billing needed.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Compute the USD cost of a request from a model's per-1M-token prices.
 *
 *   cost = (inputPricePer1m × promptTokens + outputPricePer1m × completionTokens) / 1_000_000
 *
 * Prices are the values stored on the Model (USD per 1M tokens). If either
 * price is undefined (e.g. local models like Ollama/vLLM, or catalog entries
 * that don't declare pricing), it's treated as 0 — so cost is 0 for models
 * without known pricing. Returns 0 when no tokens were consumed.
 */
export function computeCost(
  inputPricePer1m: number | undefined,
  outputPricePer1m: number | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  return ((inputPricePer1m ?? 0) * (promptTokens ?? 0) + (outputPricePer1m ?? 0) * (completionTokens ?? 0)) / 1_000_000;
}
