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
 *   - DeepSeek V4-Pro/Flash: `reasoning_effort` (low/high/max) + `thinking` toggle
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

/** The effort values a client may send (the OpenAI super-set). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const VALID_EFFORTS: ReadonlySet<ReasoningEffort> = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
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
  max: 65_536,
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

  // 6. Qwen Cloud: enable_thinking (boolean) + optional thinking_budget (token cap).
  //    enable_thinking:true  → thinking on (default depth = medium)
  //    enable_thinking:false → thinking off (none)
  //    thinking_budget:N     → infer effort from token budget
  if (typeof body.enable_thinking === 'boolean') {
    if (!body.enable_thinking) return 'none';
    if (typeof body.thinking_budget === 'number') return budgetToEffort(body.thinking_budget);
    return 'medium'; // on, no explicit depth
  }
  if (typeof body.thinking_budget === 'number') {
    return body.thinking_budget === 0 ? 'none' : budgetToEffort(body.thinking_budget);
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

/** Gemini 3.x (3.5, 3.6, 3.1, …). */
function isGemini3Model(model: string): boolean {
  return /^gemini-3/i.test(model);
}

/** Gemini 2.5 (Pro / Flash / Flash-Lite). Accepts both dotted (gemini-2.5-pro)
 *  and dashed (gemini-2-5-pro) id conventions. */
function isGemini25Model(model: string): boolean {
  return /^gemini-2[.-]5/i.test(model);
}

/** Gemini 2.5 Pro specifically — unlike 2.5 Flash / Flash-Lite, it cannot
 *  disable thinking (only Flash variants accept reasoning_effort:"none"). */
function isGemini25ProModel(model: string): boolean {
  return /^gemini-2[.-]5-pro/i.test(model);
}

/* ─────────────────────────── per-provider mapping ───────────────────── */

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
 * Translate for a Google Gemini target. SiberGate talks to Gemini via its
 * OpenAI-compatible shim (`/v1beta/openai/chat/completions`), NOT the native
 * `:generateContent` endpoint. The shim does NOT accept the native
 * `generationConfig` field — sending it yields:
 *   400 "Unknown name 'generationConfig': Cannot find field."
 *
 * The correct, model-agnostic control on the OpenAI-compat endpoint is the
 * top-level `reasoning_effort` (minimal|low|medium|high|none). Google maps it
 * internally to `thinking_level` (Gemini 3.x) or `thinking_budget` (Gemini 2.5).
 *
 * Model-specific clamps (per Google's reasoning docs):
 *   - Gemini 3.x: cannot truly disable; lowest is "minimal". `none` → `minimal`.
 *   - Gemini 2.5 Flash / Flash-Lite: support `none` (thinking off). 2.5 Pro does not.
 *   - `xhigh` is not a Gemini value → clamp to `high`.
 */
function mapForGemini(effort: ReasoningEffort, model: string): Record<string, unknown> {
  // Clamp xhigh → high (Gemini has no xhigh).
  let e: ReasoningEffort = effort === 'xhigh' ? 'high' : effort;

  // Gemini 3.x cannot disable thinking — clamp none/minimal → minimal.
  if (e === 'none' && isGemini3Model(model)) {
    e = 'minimal';
  }
  // Gemini 2.5 Pro cannot disable thinking either; only Flash / Flash-Lite can.
  if (e === 'none' && isGemini25ProModel(model)) {
    e = 'minimal';
  }
  // 'none' passes through as-is for 2.5 Flash / Flash-Lite (genuinely off).

  return { reasoning_effort: e };
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
 * Translate for xAI Grok (grok-4.5+). Per xAI's docs, Grok uses the nested
 * `reasoning: { effort }` shape (like new OpenAI). Reasoning CANNOT be
 * disabled on reasoning-first variants, so `none`/`minimal` clamp to `low`.
 * Accepted values: low / medium / high.
 */
function mapForGrok(effort: ReasoningEffort): Record<string, unknown> {
  return { reasoning: { effort: effortToGrok(effort) } };
}

/**
 * Translate for Qwen Cloud (qwen3.x). Qwen uses a boolean `enable_thinking`
 * toggle plus an optional `thinking_budget` (token cap on thinking).
 *
 *   none / minimal → enable_thinking: false                 (off)
 *   other          → enable_thinking: true + thinking_budget: <N>
 *
 * The thinking_budget gives a coarse depth mapping (Qwen has no effort levels).
 */
function mapForQwen(effort: ReasoningEffort): Record<string, unknown> {
  if (effort === 'none' || effort === 'minimal') {
    return { enable_thinking: false };
  }
  return { enable_thinking: true, thinking_budget: effortToBudget(effort) };
}

/**
 * Translate for Mistral (mistral-small/medium-latest). Per Mistral's docs, the
 * reasoning API is intentionally minimal: `reasoning_effort` accepts ONLY
 * `"high"` or `"none"`. Anything else clamps to `high` (on) or `none` (off).
 */
function mapForMistral(effort: ReasoningEffort): Record<string, unknown> {
  const e = effort === 'none' || effort === 'minimal' ? 'none' : 'high';
  return { reasoning_effort: e };
}

/**
 * Translate for Cohere (Command A Reasoning via the OpenAI-compat endpoint).
 * Cohere's compat API accepts `reasoning_effort` but ONLY `"none"` and `"high"`
 * (mapping to its native thinking toggle). medium/low/xhigh/max clamp to high.
 */
function mapForCohere(effort: ReasoningEffort): Record<string, unknown> {
  const e = effort === 'none' || effort === 'minimal' ? 'none' : 'high';
  return { reasoning_effort: e };
}

/**
 * Translate for Z.AI GLM (GLM-4.6 / GLM-5 / GLM-Z1). Per Z.AI's docs, GLM uses a
 * `thinking` object with `type: "enabled" | "disabled"`. Thinking is enabled by
 * default; there is no effort granularity (just on/off).
 *   none / minimal → thinking: { type: "disabled" }
 *   other          → thinking: { type: "enabled" }
 */
function mapForZai(effort: ReasoningEffort): Record<string, unknown> {
  const type = effort === 'none' || effort === 'minimal' ? 'disabled' : 'enabled';
  return { thinking: { type } };
}

/**
 * Translate for Moonshot / Kimi (kimi-k2.6, kimi-k2.5). Per Kimi's docs, the
 * `thinking` object accepts `type: "enabled" | "disabled"`. Thinking is enabled
 * by default; `kimi-k2.7-code` is always-on and cannot be disabled. Same shape
 * as Z.AI GLM.
 */
function mapForKimi(effort: ReasoningEffort): Record<string, unknown> {
  const type = effort === 'none' || effort === 'minimal' ? 'disabled' : 'enabled';
  return { thinking: { type } };
}

/**
 * Translate for DeepSeek (V4-Pro / V4-Flash). Per the official thinking-mode
 * guide (api-docs.deepseek.com/guides/thinking_mode), DeepSeek accepts the
 * OpenAI-style `reasoning_effort` (low/high/max — no medium/minimal/none) and
 * a `thinking` object toggle.
 *
 *   none / minimal → thinking: { type: "disabled" }  (truly off)
 *   low            → reasoning_effort: "low"
 *   medium         → reasoning_effort: "high"        (DeepSeek default; no medium)
 *   high           → reasoning_effort: "high"
 *   xhigh          → reasoning_effort: "max"
 *
 * Thinking mode is enabled by default at "high"; sending nothing lets the
 * provider default apply (backward compatible — the body is untouched when the
 * client sends no reasoning intent).
 */
function mapForDeepSeek(effort: ReasoningEffort): Record<string, unknown> {
  if (effort === 'none' || effort === 'minimal') {
    return { thinking: { type: 'disabled' } };
  }
  let ds: 'low' | 'high' | 'max';
  if (effort === 'low') ds = 'low';
  else if (effort === 'xhigh' || effort === 'max') ds = 'max';
  else ds = 'high'; // medium + high
  return { reasoning_effort: ds };
}

/**
 * Detect OpenAI's newest reasoning models that use the nested `reasoning.effort`
 * syntax (gpt-5.2+, including 5.4, 5.6, sol/terra/luna variants). These moved
 * away from the flat `reasoning_effort` top-level field.
 */
function isOpenAiNewReasoningModel(model: string): boolean {
  // gpt-5.2, gpt-5.4, gpt-5.6, gpt-5.6-sol/terra/luna, and any higher 5.x.
  return /^gpt-5[._-]?([2-9]|[1-9][0-9])/i.test(model)
    || /^gpt-5\.\d/i.test(model);
}

/**
 * Map for OpenAI itself. GPT-5.2+ uses the nested `reasoning: { effort }` shape
 * (and accepts the full value set incl. none/minimal/xhigh/max); older reasoning
 * models (o1, o3-mini, early GPT-5) use the flat `reasoning_effort` and only
 * support low/medium/high, so xhigh/max clamp to high.
 */
function mapForOpenAi(effort: ReasoningEffort, model: string): Record<string, unknown> {
  if (isOpenAiNewReasoningModel(model)) {
    return { reasoning: { effort } };
  }
  // Legacy reasoning models: flat field, clamp xhigh/max → high.
  const e = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
  return { reasoning_effort: e };
}

/**
 * Default for OpenAI-compatible providers that are NOT OpenAI itself (Mistral,
 * Groq gpt-oss, Together, Fireworks, Novita, Z.AI, Perplexity, Ollama, vLLM,
 * Cohere, unknowns). These follow the flat `reasoning_effort` convention and
 * generally do not support xhigh/max, so clamp to high.
 */
function mapForOpenAiCompat(effort: ReasoningEffort): Record<string, unknown> {
  const e = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
  return { reasoning_effort: e };
}

/* ─────────────────────────────── main entry ─────────────────────────── */

/** All reasoning-ish input fields that get stripped before re-mapping. */
const REASONING_INPUT_FIELDS = [
  'reasoning_effort', 'reasoning', 'thinking', 'thinkingConfig', 'generationConfig',
  'enable_thinking', 'thinking_budget', // Qwen Cloud
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
  // Detect whether the client sent ANY reasoning-ish field at all (regardless
  // of whether we can parse it). If they did, the field MUST be stripped or
  // re-mapped — never passed through verbatim, because:
  //   - the route target is masked (the client doesn't know the real vendor),
  //   - an unrecognized/foreign field (e.g. Anthropic `thinking` sent to a
  //     route that lands on Gemini) gets rejected upstream.
  // So: presence of a reasoning field triggers the strip path; parse success
  // additionally triggers re-mapping. A parseable-but-unknown-value field
  // (e.g. `reasoning_effort:"ultra"`) is stripped silently (effort=null → no
  // re-map) rather than leaked.
  const hasReasoningField = REASONING_INPUT_FIELDS.some((f) => f in body);
  if (!hasReasoningField) return body; // no reasoning field at all → untouched

  const effort = parseEffort(body); // may be null if value/format unrecognized

  // Strip every reasoning-ish input field so the original dialect never leaks
  // to the upstream. We preserve any OTHER generationConfig keys the client
  // may have set (temperature in generationConfig, etc.) by shallow-merging.
  const mapped = effort === null ? null : mapByProvider(effort, providerId, stripModelPath(model));

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
      clean.generationConfig = { ...gcRest, ...((mapped as Record<string, unknown> | null)?.generationConfig as Record<string, unknown> ?? {}) };
    }
  }

  // No parseable effort → nothing to re-map. Return the cleaned body (all
  // reasoning fields stripped, other fields preserved). This is the fix for
  // the leak: even an unrecognized reasoning field is removed rather than
  // forwarded to a provider that would reject it.
  if (effort === null || !mapped || mapped.stripReasoningEffort) return clean;

  return { ...clean, ...mapped };
}

/**
 * Strip path prefixes from a model id, returning the bare model name. Inference
 * hosts namespace models with the owning vendor (or their own account path):
 *   'novita/deepseek/deepseek-v4-flash'     → 'deepseek-v4-flash'
 *   'zai/glm-4.6'                           → 'glm-4.6'
 *   'fireworks/accounts/fireworks/models/deepseek-v4-flash' → 'deepseek-v4-flash'
 * We take the LAST '/' segment — the actual model name — so vendor-detection
 * regexes (which anchor on the start of the model name) work regardless of how
 * many prefix segments the host added. Using substring alone is unsafe (e.g.
 * 'hunyuan-glm' would falsely match 'glm'), so we anchor ^ AFTER stripping.
 */
function stripModelPath(model: string): string {
  const i = model.lastIndexOf('/');
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

/**
 * Detect the model "family" from its name — used as a FALLBACK when the
 * provider is an inference host (Novita, Fireworks, Together, …) that serves a
 * model owned by another vendor. Most such hosts expose an OpenAI-compat
 * endpoint and accept flat `reasoning_effort`, but some pass the request
 * through to the model's native API, which needs the model's own reasoning
 * shape (e.g. a GLM model needs `thinking:{type}` regardless of who hosts it).
 *
 * Conservative signatures only — only models with a clear, well-known id
 * prefix are detected, to avoid false positives that would send a native field
 * to a host that translates itself (causing a 400). Returns a provider-like
 * id ('zai', 'deepseek', …) or null if no family is recognized (→ flat
 * reasoning_effort default, the safe OpenAI-compat fallback).
 */
function detectModelFamily(model: string): string | null {
  // mapByProvider passes an already-stripped model, but strip again defensively
  // (idempotent) in case this is called directly.
  const m = stripModelPath(model);
  // Anthropic Claude (claude-3-7-…, claude-sonnet-4-6)
  if (/^claude/i.test(m)) return 'anthropic';
  // Z.AI / Zhipu GLM (glm-4.6, glm-5, glm-z1, …)
  if (/^glm[-_]/i.test(m)) return 'zai';
  // DeepSeek (deepseek-v4, deepseek-reasoner, deepseek-chat)
  if (/^deepseek/i.test(m)) return 'deepseek';
  // Kimi / Moonshot (kimi-k2, moonshot-kimi)
  if (/^(kimi|moonshot)/i.test(m)) return 'kimi';
  // Qwen (qwen3, qwen2.5, qwen-…)
  if (/^qwen/i.test(m)) return 'qwen';
  // xAI Grok (grok-4, grok-4.5, …)
  if (/^grok[-_]/i.test(m)) return 'xai';
  // Google Gemini (gemini-2.5, gemini-3.x, …)
  if (/^gemini[-_]/i.test(m)) return 'gemini';
  // Mistral / Magistral
  if (/^(mistral|magistral)/i.test(m)) return 'mistral';
  // Cohere Command
  if (/^command[-_]/i.test(m)) return 'cohere';
  // OpenAI GPT (gpt-4o, gpt-5, o1, o3, …)
  if (/^(gpt|o[13])/i.test(m)) return 'openai';
  return null;
}

function mapByProvider(
  effort: ReasoningEffort,
  providerId: string,
  model: string,
): Record<string, unknown> | null {
  // Primary: the known provider id (most reliable — the route target names the
  // actual upstream vendor). Covers direct-provider cases.
  switch (providerId) {
    case 'anthropic':
      return mapForAnthropic(effort, model);
    case 'gemini':
      return mapForGemini(effort, model);
    case 'openrouter':
      return mapForOpenRouter(effort);
    case 'deepseek':
      return mapForDeepSeek(effort);
    case 'xai':
    case 'grok':
      return mapForGrok(effort);
    case 'qwencloud':
    case 'qwen':
      return mapForQwen(effort);
    case 'openai':
      // Hybrid: GPT-5.2+ → nested reasoning.effort; older → flat reasoning_effort.
      return mapForOpenAi(effort, model);
    case 'mistral':
      // Mistral accepts only reasoning_effort "high" or "none".
      return mapForMistral(effort);
    case 'cohere':
      // Cohere compat API accepts only reasoning_effort "none" or "high".
      return mapForCohere(effort);
    case 'zai':
      // Z.AI GLM uses a thinking:{type} toggle (no effort granularity).
      return mapForZai(effort);
    case 'kimi':
    case 'moonshot':
      // Kimi/Moonshot use a thinking:{type} toggle (same shape as Z.AI).
      return mapForKimi(effort);
  }

  // Fallback for inference hosts & unknown providers: detect the model family
  // from its name. If the model belongs to a vendor whose native reasoning
  // shape differs from flat reasoning_effort (GLM, DeepSeek, Kimi, Qwen, …),
  // use that vendor's mapping — the model needs its native field regardless of
  // who hosts it. OpenAI-family models and unrecognized models fall through to
  // the safe flat reasoning_effort default.
  const family = detectModelFamily(model);
  if (family && family !== 'openai') {
    // Re-enter mapByProvider with the detected vendor id, so the vendor's own
    // clamps/shape apply (e.g. GLM→thinking toggle, DeepSeek→low/high/max).
    return mapByProvider(effort, family, model);
  }

  // Pure OpenAI-compatible inference hosts (NOT model-owning providers):
  // flat reasoning_effort. These host third-party models and follow the
  // OpenAI convention — Groq gpt-oss, Together, Fireworks, Novita, Ollama,
  // vLLM, Perplexity, and unknowns. OpenAI-family models also land here.
  return mapForOpenAiCompat(effort);
}
