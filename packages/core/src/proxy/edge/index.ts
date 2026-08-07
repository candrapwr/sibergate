/**
 * Edge Relay registry — map EdgeProviderId → EdgeRelayProvider impl.
 * Mirror pola ADAPTERS di provider.ts. Nambah provider (Vercel/Deno/AWS) =
 * +1 file impl + 1 line di map. Tidak sentuh core logic.
 */
import { cloudflareProvider } from './cloudflare.js';
import type { EdgeProviderId, EdgeRelayProvider } from './types.js';

export type {
  EdgeProviderId,
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
} from './types.js';

const REGISTRY: Record<EdgeProviderId, EdgeRelayProvider> = {
  'cloudflare-workers': cloudflareProvider,
  // 'vercel-edge': vercelProvider,     // future: +1 line
  // 'deno-deploy': denoProvider,       // future
  // 'netlify-edge': netlifyProvider,   // future
  // 'aws-lambda-edge': awsProvider,    // future
};

/** Daftar semua provider edge relay (utk UI dropdown). */
export function listEdgeProviders(): Array<{ id: EdgeProviderId; displayName: string }> {
  return Object.values(REGISTRY).map((p) => ({ id: p.id, displayName: p.displayName }));
}

/** Lookup provider by id. Throw bila tidak terdaftar. */
export function getEdgeProvider(id: string): EdgeRelayProvider {
  const provider = REGISTRY[id as EdgeProviderId];
  if (!provider) throw new Error(`Unknown edge relay provider: ${id}`);
  return provider;
}

/** Cek apakah id provider edge valid. */
export function isEdgeProvider(id: string): id is EdgeProviderId {
  return id in REGISTRY;
}
