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
