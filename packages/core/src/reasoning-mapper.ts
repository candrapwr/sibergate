/**
 * Reasoning/thinking mapping — translate a client's `reasoning_effort`
 * (OpenAI-style) into each provider's NATIVE reasoning format before the
 * request is sent upstream.
 *
 * Why: every vendor exposes "thinking" controls differently:
 *   - OpenAI / OpenAI-compat: top-level `reasoning_effort`
 *   - Anthropic (Claude 3.7+/4.x/5): `thinking` object + `effort` (adaptive)
 *   - Google Gemini 3.x: `generationConfig.thinkingConfig.thinkingLevel`
 *   - Google Gemini 2.5:  `generationConfig.thinkingConfig.thinkingBudget`
 *   - OpenRouter: `reasoning.effort` (OR normalizes downstream)
 *   - DeepSeek: implicit (no field — reasoner/v4-pro think automatically)
 *
 * The client sends ONE shape (`reasoning_effort`), and SiberGate maps it to
 * whatever the selected target speaks. Failover across vendors works because
 * the mapper runs per-target inside each adapter (the body is never mutated
 * in place — we build a fresh object).
 *
 * When the client sends NO `reasoning_effort`, this module returns the body
 * unchanged (backward compatible — provider defaults apply).
 *
 * Precedence: if the client already sent a provider-NATIVE field
 * (`thinking`, `thinkingConfig`, `reasoning`), we RESPECT it and skip mapping.
 */

/** The OpenAI-style effort values a client may send. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const VALID_EFFORTS: ReadonlySet<ReasoningEffort> = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
]);

/**
 * Token budget mapping for budget-based formats (Gemini 2.5 thinkingBudget,
 * Claude 3.7 legacy budget_tokens). `xhigh` gets the largest sane budget.
 * `none`/`minimal` map to a tiny budget (effectively "think very little") —
 * note that for the true "off" case, provider-specific disabled fields are
 * used instead (see the per-provider branches).
 */
const EFFORT_TO_BUDGET: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 16_384,
  xhigh: 32_768,
};

/** Map an effort value to a token budget (used by Gemini 2.5 / Claude 3.7). */
export function effortToBudget(effort: ReasoningEffort): number {
  if (effort === 'none') return 0;
  return EFFORT_TO_BUDGET[effort] ?? 4096;
}

/**
 * Pull a client intent from the body. Accepts MULTIPLE input dialects and
 * normalizes them to the canonical effort level:
 *
 *   1. OpenAI top-level: `reasoning_effort: "high"`
 *   2. OpenAI nested:    `reasoning: { effort: "high" }`
 *   3. OpenRouter:       `reasoning: { effort: "high", max_tokens: N }`
 *   4. Anthropic:        `thinking: { type: "adaptive"|"enabled"|"disabled" }`
 *                        (+ optional `effort:` sibling or `budget_tokens:`)
 *   5. Gemini:           `generationConfig.thinkingConfig.{thinkingLevel|thinkingBudget}`
 *
 * This two-way parsing is critical because the client doesn't know the real
 * target — routes are masked (virtual ids), and failover can switch vendors
 * mid-flight. So a `thinking` object aimed at Anthropic must be re-translated
 * if the route ends up at Gemini, otherwise Gemini rejects the foreign field.
 *
 * Returns null when the client expressed no reasoning intent (→ no mapping).
 */
function parseEffort(body: Record<string, unknown>): ReasoningEffort | null {
  // 1. OpenAI top-level string.
  const top = body.reasoning_effort;
  if (typeof top === 'string') return normalizeEffort(top);

  // 2-3. OpenAI nested / OpenRouter: reasoning: { effort: "..." }
  const nested = body.reasoning;
  if (nested && typeof nested === 'object') {
    const e = (nested as { effort?: unknown }).effort;
    if (typeof e === 'string') return normalizeEffort(e);
    // OpenRouter reasoning.max_tokens → infer effort from token budget.
    const mt = (nested as { max_tokens?: unknown }).max_tokens;
    if (typeof mt === 'number') return budgetToEffort(mt);
  }

  // 4. Anthropic: thinking: { type, budget_tokens?, effort? }
  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object') {
    const t = thinking as { type?: unknown; budget_tokens?: unknown; effort?: unknown };
    if (typeof t.effort === 'string') return normalizeEffort(t.effort);
    if (typeof t.budget_tokens === 'number') return budgetToEffort(t.budget_tokens);
    if (t.type === 'disabled') return 'none';
    if (t.type === 'adaptive' || t.type === 'enabled') return 'medium'; // on, unknown depth → default medium
  }

  // 5. Gemini: generationConfig.thinkingConfig.{thinkingLevel|thinkingBudget}
  const gc = body.generationConfig;
  if (gc && typeof gc === 'object') {
    const tc = (gc as { thinkingConfig?: unknown }).thinkingConfig;
    if (tc && typeof tc === 'object') {
      const cfg = tc as { thinkingLevel?: unknown; thinkingBudget?: unknown };
      if (typeof cfg.thinkingBudget === 'number') {
        if (cfg.thinkingBudget === 0) return 'none';
        return budgetToEffort(cfg.thinkingBudget);
      }
      if (typeof cfg.thinkingLevel === 'string') {
        const lvl = cfg.thinkingLevel.toLowerCase();
        if (lvl === 'low') return 'low';
        if (lvl === 'medium') return 'medium';
        if (lvl === 'high') return 'high';
      }
    }
  }

  return null;
}

/** Map a token budget back to an effort level (inverse of effortToBudget). */
function budgetToEffort(budget: number): ReasoningEffort {
  if (budget <= 0) return 'none';
  if (budget <= 700) return 'minimal';
  if (budget <= 1500) return 'low';
  if (budget <= 8000) return 'medium';
  if (budget <= 20000) return 'high';
  return 'xhigh';
}

function normalizeEffort(raw: string): ReasoningEffort | null {
  const v = raw.trim().toLowerCase() as ReasoningEffort;
  return VALID_EFFORTS.has(v) ? v : null;
}

/* ────────────────────── provider/model detection ────────────────────── */

/** Claude 3.7+ supports thinking (adaptive on 4.x/5, budget on 3.7). */
function isAnthropicThinkingModel(model: string): boolean {
  // claude-3-7-* | claude-4* / opus-4 / sonnet-4 / haiku-4 | claude-5* | fable-5
  return /^claude-(3-7|[4-9]|1[0-9]|fable|opus|sonnet|haiku)/i.test(model)
    || /^claude-(3-7|[4-9])/i.test(model);
}

/** Claude 3.7 is the legacy "budget_tokens" generation (4.x+ use adaptive). */
function isAnthropicLegacyModel(model: string): boolean {
  return /^claude-3-7/i.test(model);
}

/** Gemini 3.x uses thinkingLevel (LOW/MEDIUM/HIGH). */
function isGemini3Model(model: string): boolean {
  return /^gemini-3/i.test(model);
}

/** Gemini 2.5 uses thinkingBudget (numeric token count). Accepts both
 *  dotted (gemini-2.5-pro) and dashed (gemini-2-5-pro) id conventions. */
function isGemini25Model(model: string): boolean {
  return /^gemini-2[.-]5/i.test(model);
}

/* ─────────────────────────── per-provider mapping ───────────────────── */

/** Gemini thinkingLevel accepts only LOW/MEDIUM/HIGH (no none/minimal/xhigh). */
function effortToGeminiLevel(effort: ReasoningEffort): 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low': return 'LOW';
    case 'xhigh':
    case 'high': return 'HIGH';
    case 'medium':
    default: return 'MEDIUM';
  }
}

/** Grok is reasoning-first; "none" can't truly disable, so clamp to "low". */
function effortToGrok(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low': return 'low';
    case 'xhigh':
    case 'high': return 'high';
    case 'medium':
    default: return 'medium';
  }
}

/**
 * Translate `effort` for an Anthropic (Claude) target. Returns the fields to
 * merge into the body (or null if nothing to add).
 *
 *   none  → thinking: { type: 'disabled' }   (model stops thinking)
 *   other → thinking: { type: 'adaptive' }, effort: <e>           (Claude 4.x/5)
 *   other → thinking: { type: 'enabled', budget_tokens: <N> }    (Claude 3.7 legacy)
 *
 * `effort` is accepted as a sibling field by the adaptive generation.
 */
function mapForAnthropic(effort: ReasoningEffort, model: string): Record<string, unknown> | null {
  if (!isAnthropicThinkingModel(model)) {
    // Claude 3.5 and earlier have no thinking support — strip the OpenAI field
    // (sending it would be a no-op, but removing it keeps the body clean).
    return { stripReasoningEffort: true };
  }
  if (effort === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  if (isAnthropicLegacyModel(model)) {
    // 3.7: budget_tokens, no adaptive effort field.
    return { thinking: { type: 'enabled', budget_tokens: effortToBudget(effort) } };
  }
  // 4.x/5: adaptive thinking + effort. Clamp xhigh→high (Anthropic caps at high).
  const e = effort === 'xhigh' ? 'high' : effort;
  return { thinking: { type: 'adaptive' }, effort: e };
}

/**
 * Translate for a Google Gemini target (via the OpenAI-compat shim endpoint).
 * Places the native config under `generationConfig.thinkingConfig`.
 *
 *   none  → thinkingBudget: 0        (disable)
 *   Gemini 3.x → thinkingLevel: LOW/MEDIUM/HIGH
 *   Gemini 2.5 → thinkingBudget: <N>
 */
function mapForGemini(effort: ReasoningEffort, model: string): Record<string, unknown> | null {
  if (effort === 'none') {
    return {
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    };
  }
  if (isGemini3Model(model)) {
    return {
      generationConfig: { thinkingConfig: { thinkingLevel: effortToGeminiLevel(effort) } },
    };
  }
  if (isGemini25Model(model)) {
    return {
      generationConfig: { thinkingConfig: { thinkingBudget: effortToBudget(effort) } },
    };
  }
  // Older Gemini (2.0 and below) — no thinking controls. Strip the OpenAI field.
  return { stripReasoningEffort: true };
}

/**
 * Translate for OpenRouter. OR exposes a normalized `reasoning` object that it
 * maps downstream to each backing provider, so we speak its dialect.
 *   none  → reasoning: { effort: 'none' }
 *   other → reasoning: { effort: <e> }
 */
function mapForOpenRouter(effort: ReasoningEffort): Record<string, unknown> {
  return { reasoning: { effort } };
}

/**
 * Translate for xAI Grok. Grok is reasoning-first; `none` clamps to `low`
 * (can't truly disable on reasoning-focused variants).
 */
function mapForGrok(effort: ReasoningEffort): Record<string, unknown> {
  return { reasoning_effort: effortToGrok(effort) };
}

/**
 * Translate for DeepSeek. Reasoner/v4-pro think automatically; there is no
 * request-side field. `none` cannot disable it. We just drop the OpenAI field
 * so it isn't rejected as unknown.
 */
function mapForDeepSeek(): Record<string, unknown> | null {
  return { stripReasoningEffort: true };
}

/**
 * Default (OpenAI / OpenAI-compat): keep the top-level `reasoning_effort`.
 * Clamp `xhigh` → `high` (only the very newest OpenAI models accept xhigh;
 * older ones reject it). Keeps the wire field as the client sent it otherwise.
 */
function mapForOpenAiCompat(effort: ReasoningEffort): Record<string, unknown> {
  const e = effort === 'xhigh' ? 'high' : effort;
  return { reasoning_effort: e };
}

/* ─────────────────────────────── main entry ─────────────────────────── */

/** All reasoning-ish input fields that get stripped before re-mapping. */
const REASONING_INPUT_FIELDS = [
  'reasoning_effort', 'reasoning', 'thinking', 'thinkingConfig', 'generationConfig',
] as const;

/**
 * Map a client request body's reasoning intent to the target provider's native
 * format. Returns a FRESH body object (never mutates the input — the same body
 * is reused across failover targets, so in-place mutation would leak).
 *
 * TWO-WAY translation: ANY reasoning dialect the client sent — OpenAI
 * `reasoning_effort`, nested `reasoning.effort`, Anthropic `thinking`,
 * Gemini `generationConfig.thinkingConfig`, OpenRouter `reasoning.max_tokens` —
 * is first normalized to a canonical effort level, then re-translated to the
 * TARGET provider's native shape. This is essential because routes are masked
 * (the client sends a virtual route id, not a real model) and failover can
 * switch vendors mid-flight: a `thinking` object meant for Anthropic must be
 * re-spoken as `thinkingConfig` if the route lands on Gemini, otherwise Gemini
 * rejects the foreign field.
 *
 * Rules:
 *  - No reasoning intent detectable in any form → body unchanged (provider
 *    defaults apply, backward compatible).
 *  - Intent found → strip ALL input reasoning fields, then emit ONLY the
 *    target's native shape. The original dialect never reaches the upstream.
 */
export function mapReasoning(
  body: Record<string, unknown>,
  providerId: string,
  model: string,
): Record<string, unknown> {
  const effort = parseEffort(body);
  if (effort === null) return body; // no client intent → no-op

  const mapped = mapByProvider(effort, providerId, model);

  // Strip every reasoning-ish input field so the original dialect never leaks
  // to the upstream alongside the re-mapped native shape. We preserve any
  // OTHER generationConfig keys the client may have set (temperature in
  // generationConfig, etc.) by shallow-merging.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if ((REASONING_INPUT_FIELDS as readonly string[]).includes(k)) continue;
    clean[k] = v;
  }
  // generationConfig may carry non-reasoning keys (temperature, topP, …) on
  // Gemini. Re-merge the original minus its thinkingConfig, then let the
  // mapped shape (which may include a fresh generationConfig) win.
  if (body.generationConfig && typeof body.generationConfig === 'object') {
    const { thinkingConfig: _drop, ...gcRest } = body.generationConfig as Record<string, unknown>;
    if (Object.keys(gcRest).length > 0) {
      clean.generationConfig = { ...gcRest, ...((mapped as Record<string, unknown>).generationConfig as Record<string, unknown> ?? {}) };
    }
  }

  // Sentinel: provider doesn't support reasoning — nothing to add (already stripped).
  if (mapped && mapped.stripReasoningEffort) return clean;

  return { ...clean, ...mapped };
}

function mapByProvider(
  effort: ReasoningEffort,
  providerId: string,
  model: string,
): Record<string, unknown> | null {
  switch (providerId) {
    case 'anthropic':
      return mapForAnthropic(effort, model);
    case 'gemini':
      return mapForGemini(effort, model);
    case 'openrouter':
      return mapForOpenRouter(effort);
    case 'deepseek':
      return mapForDeepSeek();
    case 'xai':
    case 'grok':
      return mapForGrok(effort);
    // OpenAI-compat providers: keep reasoning_effort (Mistral, Groq gpt-oss,
    // Together, Fireworks, Novita, Z.AI, Perplexity, Ollama, vLLM, ...).
    case 'openai':
    case 'mistral':
    case 'groq':
    case 'together':
    case 'fireworks':
    case 'novita':
    case 'zai':
    case 'perplexity':
    case 'ollama':
    case 'vllm':
    case 'cohere':
    default:
      return mapForOpenAiCompat(effort);
  }
}
