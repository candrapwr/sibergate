import type { Provider, Route, RouteModality, RouteTarget, SiberGateConfig } from './types.js';
import { getLatency, hasLatencyEstimate, recordFailure, recordLatency } from './latency.js';
import { callProvider, GatewayCallError, isFailoverable } from './provider.js';
import { pushConsoleLog } from './console-log.js';

/**
 * Run `fn` with a fresh AbortController whose timeout is `budgetMs`, while
 * ALSO propagating an abort from the parent `signal` (client disconnect /
 * overall route timeout). Whichever fires first wins.
 *
 * Returns whatever `fn` resolves to, and always cleans up its timer + parent
 * listener so the next failover iteration starts from a clean slate.
 *
 * This is the crux of per-target timeout: each failover target gets its OWN
 * budget instead of sharing one signal across all targets (which caused the
 * first slow target to consume the entire route timeout, leaving the rest
 * to fail instantly at 0ms).
 */
async function withTargetTimeout<T>(
  parentSignal: AbortSignal,
  budgetMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  // If the parent (client disconnect / overall budget) aborts, abort the child
  // immediately so we stop the in-flight upstream call.
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}

/**
 * The routing engine: resolve a client route to a successful upstream Response,
 * applying the route's strategy across its targets — now GENERIC across all
 * modalities (chat, image, speech, transcribe, embed, music).
 *
 * The route's `modality` field selects which adapter handles the call, and only
 * targets whose provider actually supports that modality (has an endpoint for
 * it) are considered. Strategies (fallback/fastest/weighted) apply uniformly.
 */

/** One step in the failover trail — for audit/logging. */
export interface FailoverStep {
  provider: string;
  model: string;
  outcome: 'served' | 'failed';
  status?: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
  /** Upstream key id yg dipakai/langkah ini gagal (provider_keys.id), bila ada. */
  keyId?: string | null;
}

export interface ExecuteResult {
  response: Response;
  servedBy: RouteTarget;
  latencyMs: number;
  /** Ordered list of every target tried, with outcome — the failover audit trail. */
  trail: FailoverStep[];
  /** Upstream key id yg melayani request (provider_keys.id); null = default key. */
  servedByKeyId?: string | null;
}

export async function executeRoute(
  config: SiberGateConfig,
  route: Route,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ExecuteResult> {
  const routeModality: RouteModality = route.modality ?? 'chat';
  const isToolsTextModality = (m: RouteModality): boolean =>
    m === 'tools-text' || m === 'tools-text-stream' || m === 'tools-text-nonstream';
  // Modality efektif tiap target: override bila di-set, jika tidak pakai
  // route.modality. Memungkinkan route campur target dgn modality berbeda
  // (mis. OpenAI responses + DeepSeek chat di route yg sama, dgn failover
  // antar modality).
  const effectiveModality = (t: RouteTarget): RouteModality => t.modality ?? routeModality;

  // Filter targets: enabled + provider enabled + provider supports modality
  // efektif target tsb + model enabled. Provider "supports" modality ketika
  // endpoints map-nya punya key utk modality itu. Bila target.keyId di-set tapi
  // key tsb disabled/tidak ditemukan → skip (anggap gak usable, biar failover).
  const usable = route.targets.filter((t) => {
    if (!t.enabled) return false;
    const p = config.providers.find((x) => x.id === t.providerId && x.enabled);
    if (!p) return false;
    const em = effectiveModality(t);
    // Modality tools-text* reuse endpoint chat (tool calling via text generation,
    // upstream tetap /v1/chat/completions). Anggap supported bila endpoint chat ada.
    const endpointKey = isToolsTextModality(em) ? 'chat' : em;
    if (!p.endpoints[endpointKey]) return false;
    const m = config.models.find((x) => x.id === t.modelId && x.enabled);
    if (!m) return false;
    if (t.keyId) {
      const k = config.providerKeys.find((x) => x.id === t.keyId && x.enabled && x.providerId === t.providerId);
      if (!k) return false;
    }
    return true;
  });

  if (usable.length === 0) {
    pushConsoleLog('error', 'routing', `route '${route.id}' has no enabled targets`, {
      route: route.id, reason: 'no_targets',
    });
    throw new GatewayCallError(
      'no_targets',
      `Route '${route.id}' has no enabled targets that support its modality.`,
    );
  }

  const ordered = orderTargets(route.strategy, usable);
  const attempts =
    route.strategy === 'weighted'
      ? [ordered[0]!, ...usable.filter((t) => t !== ordered[0])].slice(0, Math.max(1, route.maxRetries ?? usable.length))
      : ordered.slice(0, Math.max(1, route.maxRetries ?? usable.length));

  // Per-target timeout budget. By design each target gets the FULL route
  // timeout, NOT a divided slice: route.timeoutMs is treated as a per-target
  // limit. So a route with 30s and 4 targets lets each target run up to 30s
  // (worst-case total ~120s if all time out). This maximizes failover success
  // — a slow target never steals time from the next one. The only thing that
  // cuts a target short is the client disconnecting (parent signal abort).
  const perTargetBudgetMs = Math.max(1_000, route.timeoutMs ?? 30_000);

  let lastErr: unknown;
  let lastTarget: RouteTarget | null = null;
  const trail: FailoverStep[] = [];

  for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
    const target = attempts[attemptIdx]!;
    const hasMore = attemptIdx < attempts.length - 1;
    // Stop failover only if the client disconnected (parent signal aborted).
    // Each target runs up to its own full per-target budget; there is no
    // shared overall deadline — route.timeoutMs is per-target by design.
    if (signal.aborted) {
      if (!lastErr) {
        lastErr = new GatewayCallError('client_closed_request', `Client disconnected before the request completed.`);
      }
      break;
    }
    const baseProvider = config.providers.find((p) => p.id === target.providerId)!;
    // Resolve upstream key: bila target.keyId di-set & key enabled ada, clone
    // provider dgn value key tsb; bila tidak, pakai provider.apiKey default.
    // Clone (bukan mutate) supaya config shared gak terkontaminasi antar iterasi.
    const key = target.keyId
      ? config.providerKeys.find((k) => k.id === target.keyId && k.enabled && k.providerId === target.providerId)
      : null;
    const provider = key ? { ...baseProvider, apiKey: key.value } : baseProvider;
    lastTarget = target;
    // Modality target ini (override atau route default). Dipakai utk pilih
    // adapter saat dispatch. servedBy (RouteTarget) juga membawa modality ini
    // supaya gateway tahu converter mana yg dipakai saat response dikembalikan.
    const modality = effectiveModality(target);
    const start = Date.now();
    // target.modelId adalah id internal namespaced ('{provider}/{name}'). Upstream
    // provider hanya mengenal nama asli, jadi strip prefix '{providerId}/' sebelum
    // dikirim ke adapter (body.model + URL {model}). Tanpa ini, DeepInfra mis.
    // menerima 'deepinfra/deepseek-ai/...' dan membalas 404 model not found.
    const upstreamModel = target.modelId.startsWith(`${target.providerId}/`)
      ? target.modelId.slice(target.providerId.length + 1)
      : target.modelId;
    try {
      const stepNoBefore = trail.length + 1;
      // Each target gets the FULL route timeout as its own budget (not a slice).
      pushConsoleLog('info', 'upstream', `step #${stepNoBefore} calling upstream ${target.providerId}/${target.modelId} (budget ${perTargetBudgetMs}ms)`, {
        route: route.id, step: stepNoBefore, totalSteps: attempts.length,
        provider: target.providerId, model: target.modelId, modality, strategy: route.strategy,
        targetBudgetMs: perTargetBudgetMs,
      });
      const response = await withTargetTimeout(signal, perTargetBudgetMs, (targetSignal) =>
        callProvider({ provider, model: upstreamModel, body, signal: targetSignal, modality }),
      );
      const latencyMs = Date.now() - start;
      recordLatency(target.providerId, target.modelId, latencyMs);
      trail.push({ provider: target.providerId, model: target.modelId, outcome: 'served', latencyMs, keyId: key?.id ?? null });
      const stepNo = trail.length;
      pushConsoleLog('success', 'routing', `step #${stepNo} served by ${target.providerId}/${target.modelId} (${latencyMs}ms)`, {
        route: route.id, step: stepNo, totalSteps: attempts.length,
        provider: target.providerId, model: target.modelId, latencyMs, outcome: 'served',
      });
      return { response, servedBy: target, latencyMs, trail, servedByKeyId: key?.id ?? null };
    } catch (err) {
      const latencyMs = Date.now() - start;
      recordFailure(target.providerId, target.modelId);
      const ge = err as GatewayCallError;
      trail.push({
        provider: target.providerId,
        model: target.modelId,
        outcome: 'failed',
        status: ge.status,
        errorCode: ge.code,
        errorMessage: ge.message?.slice(0, 300),
        latencyMs,
        keyId: key?.id ?? null,
      });
      const stepNo = trail.length;
      const failMsg = ge.status ? `${ge.code ?? 'error'} ${ge.status}` : (ge.code ?? 'error');
      pushConsoleLog(
        'warn',
        'routing',
        `step #${stepNo} ${target.providerId}/${target.modelId} failed (${failMsg})${hasMore ? ' → failover' : ' (last target)'}`,
        {
          route: route.id, step: stepNo, totalSteps: attempts.length,
          provider: target.providerId, model: target.modelId, latencyMs, outcome: 'failed',
          status: ge.status, errorCode: ge.code, errorMessage: ge.message?.slice(0, 300),
          failover: hasMore,
        },
      );
      lastErr = err;
      if (!isFailoverable(err)) {
        if (err instanceof GatewayCallError)
          err.servedBy = { provider: target.providerId, model: target.modelId, keyId: key?.id ?? null };
        throw err;
      }
      // else: loop to next target (failover) — target berikutnya mungkin punya
      // modality berbeda (mis. responses gagal → failover ke chat). Adapter &
      // converter disesuaikan otomatis per-iterasi via effectiveModality().
    }
  }

  if (lastErr instanceof GatewayCallError && lastTarget) {
    lastErr.servedBy = { provider: lastTarget.providerId, model: lastTarget.modelId, keyId: lastTarget.keyId ?? null };
    lastErr.trail = trail;
    pushConsoleLog('error', 'routing', `route '${route.id}' exhausted all ${trail.length} target(s) — last error`, {
      route: route.id, steps: trail.length, lastError: lastErr.message?.slice(0, 300),
    });
    throw lastErr;
  }
  pushConsoleLog('error', 'routing', `route '${route.id}' all targets failed`, {
    route: route.id, steps: trail.length,
  });
  const allErr = new GatewayCallError('all_failed', 'All targets failed.');
  allErr.trail = trail;
  throw allErr;
}

function orderTargets(strategy: Route['strategy'], targets: RouteTarget[]): RouteTarget[] {
  const copy = [...targets];
  switch (strategy) {
    case 'fastest':
      return copy.sort((a, b) => {
        const aKnown = hasLatencyEstimate(a.providerId, a.modelId);
        const bKnown = hasLatencyEstimate(b.providerId, b.modelId);
        if (aKnown !== bKnown) return aKnown ? 1 : -1;
        return getLatency(a.providerId, a.modelId) - getLatency(b.providerId, b.modelId);
      });
    case 'weighted':
      return [pickWeighted(copy)];
    case 'fallback':
    default:
      return copy.sort((a, b) => a.priority - b.priority);
  }
}

function pickWeighted(targets: RouteTarget[]): RouteTarget {
  const total = targets.reduce((s, t) => s + Math.max(1, t.weight), 0);
  let r = Math.random() * total;
  for (const t of targets) {
    r -= Math.max(1, t.weight);
    if (r <= 0) return t;
  }
  return targets[targets.length - 1]!;
}
