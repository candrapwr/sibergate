import type { Provider, Route, RouteModality, RouteTarget, SiberGateConfig } from './types.js';
import { getLatency, recordFailure, recordLatency } from './latency.js';
import { callProvider, GatewayCallError, isFailoverable } from './provider.js';

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
}

export interface ExecuteResult {
  response: Response;
  servedBy: RouteTarget;
  latencyMs: number;
  /** Ordered list of every target tried, with outcome — the failover audit trail. */
  trail: FailoverStep[];
}

export async function executeRoute(
  config: SiberGateConfig,
  route: Route,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ExecuteResult> {
  const modality: RouteModality = route.modality ?? 'chat';

  // Filter targets: enabled + provider enabled + provider supports this modality
  // + model enabled. A provider "supports" a modality when its endpoints map
  // has a key for it.
  const usable = route.targets.filter((t) => {
    if (!t.enabled) return false;
    const p = config.providers.find((x) => x.id === t.providerId && x.enabled);
    if (!p) return false;
    if (!p.endpoints[modality]) return false;
    const m = config.models.find((x) => x.id === t.modelId && x.enabled);
    return !!m;
  });

  if (usable.length === 0) {
    throw new GatewayCallError(
      'no_targets',
      `Route '${route.id}' has no enabled targets that support modality '${modality}'.`,
    );
  }

  const ordered = orderTargets(route.strategy, usable);
  const attempts =
    route.strategy === 'weighted'
      ? [ordered[0]!, ...usable.filter((t) => t !== ordered[0])].slice(0, Math.max(1, route.maxRetries ?? usable.length))
      : ordered.slice(0, Math.max(1, route.maxRetries ?? usable.length));

  let lastErr: unknown;
  let lastTarget: RouteTarget | null = null;
  const trail: FailoverStep[] = [];

  for (const target of attempts) {
    const provider = config.providers.find((p) => p.id === target.providerId)!;
    lastTarget = target;
    const start = Date.now();
    // target.modelId adalah id internal namespaced ('{provider}/{name}'). Upstream
    // provider hanya mengenal nama asli, jadi strip prefix '{providerId}/' sebelum
    // dikirim ke adapter (body.model + URL {model}). Tanpa ini, DeepInfra mis.
    // menerima 'deepinfra/deepseek-ai/...' dan membalas 404 model not found.
    const upstreamModel = target.modelId.startsWith(`${target.providerId}/`)
      ? target.modelId.slice(target.providerId.length + 1)
      : target.modelId;
    try {
      const response = await callProvider({ provider, model: upstreamModel, body, signal, modality });
      const latencyMs = Date.now() - start;
      recordLatency(target.providerId, target.modelId, latencyMs);
      trail.push({ provider: target.providerId, model: target.modelId, outcome: 'served', latencyMs });
      return { response, servedBy: target, latencyMs, trail };
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
      });
      lastErr = err;
      if (!isFailoverable(err)) {
        if (err instanceof GatewayCallError)
          err.servedBy = { provider: target.providerId, model: target.modelId };
        throw err;
      }
      // else: loop to next target (failover)
    }
  }

  if (lastErr instanceof GatewayCallError && lastTarget) {
    lastErr.servedBy = { provider: lastTarget.providerId, model: lastTarget.modelId };
    lastErr.trail = trail;
    throw lastErr;
  }
  const allErr = new GatewayCallError('all_failed', 'All targets failed.');
  allErr.trail = trail;
  throw allErr;
}

function orderTargets(strategy: Route['strategy'], targets: RouteTarget[]): RouteTarget[] {
  const copy = [...targets];
  switch (strategy) {
    case 'fastest':
      return copy.sort((a, b) => getLatency(a.providerId, a.modelId) - getLatency(b.providerId, b.modelId));
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
