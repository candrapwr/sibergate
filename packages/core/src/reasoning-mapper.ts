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
 * Pull a client intent from the body. Accepts the canonical `reasoning_effort`
 * (string) and OpenAI's nested `reasoning.effort` shape. Returns null when the
 * client expressed no reasoning intent (→ no mapping, provider default).
 */
function parseEffort(body: Record<string, unknown>): ReasoningEffort | null {
  const top = body.reasoning_effort;
  if (typeof top === 'string') return normalizeEffort(top);
  const nested = body.reasoning;
  if (nested && typeof nested === 'object') {
    const e = (nested as { effort?: unknown }).effort;
    if (typeof e === 'string') return normalizeEffort(e);
  }
  return null;
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

/**
 * Map a client request body's reasoning intent to the target provider's native
 * format. Returns a FRESH body object (never mutates the input — the same body
 * is reused across failover targets, so in-place mutation would leak).
 *
 * Rules:
 *  - No `reasoning_effort` (and no `reasoning.effort`) → body unchanged.
 *  - Client already sent a NATIVE field (`thinking`/`thinkingConfig`/`reasoning`)
 *    → respect it; do not overwrite (precedence: native > effort).
 *  - Otherwise → translate per provider.id + model name.
 */
export function mapReasoning(
  body: Record<string, unknown>,
  providerId: string,
  model: string,
): Record<string, unknown> {
  const effort = parseEffort(body);
  if (effort === null) return body; // no client intent → no-op

  // Precedence: a provider-NATIVE field the client already set wins. But note
  // `reasoning.effort` is the OpenAI *input* dialect (also parseEffort's source),
  // NOT a native override — so we only treat a bare `reasoning` object WITHOUT
  // an `effort` child, or `thinking`/`thinkingConfig`, as native overrides.
  const hasNativeOverride =
    !!body.thinking
    || !!body.thinkingConfig
    || (!!body.reasoning && typeof body.reasoning === 'object'
        && (body.reasoning as { effort?: unknown }).effort === undefined);
  if (hasNativeOverride) {
    const { reasoning_effort: _drop, ...rest } = body;
    return rest;
  }

  const mapped = mapByProvider(effort, providerId, model);

  // Sentinel: provider doesn't support reasoning — strip the OpenAI field only.
  if (mapped && mapped.stripReasoningEffort) {
    const { reasoning_effort: _drop, ...rest } = body;
    return rest;
  }

  // Merge mapped fields onto a fresh copy. We also drop the original
  // `reasoning_effort` (and nested `reasoning`) so we don't send both the
  // OpenAI shape AND the native shape to the upstream.
  const { reasoning_effort: _drop1, reasoning: _drop2, ...clean } = body;
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
