/**
 * Edge Relay registry — map EdgeProviderId → EdgeRelayProvider impl.
 * Mirror pola ADAPTERS di provider.ts. Nambah provider (Vercel/Deno/AWS) =
 * +1 file impl + 1 line di map. Tidak sentuh core logic.
 */
import { cloudflareProvider } from './cloudflare.js';
import { vercelProvider } from './vercel.js';
import { netlifyProvider } from './netlify.js';
import type { EdgeProviderId, EdgeRelayProvider } from './types.js';

export type {
  EdgeProviderId,
  EdgeRelayProvider,
  EdgeRelayRuntime,
  VerifyResult,
  DeployResult,
  RemoveResult,
  ConnectivityResult,
  ConfigField,
  EdgeProviderStatus,
} from './types.js';

const REGISTRY: Record<EdgeProviderId, EdgeRelayProvider> = {
  'cloudflare-workers': cloudflareProvider,
  'vercel-edge': vercelProvider,
  'netlify-edge': netlifyProvider,
  // 'deno-deploy': denoProvider,          // Dihapus — Deno suspend akun utk relay/proxy
  // 'aws-lambda-edge': awsProvider,       // future — arsitektur beda (IAM + Lambda + CloudFront)
};

/** Daftar semua provider edge relay (utk UI dropdown + info panel). */
export function listEdgeProviders(): Array<{
  id: EdgeProviderId;
  displayName: string;
  description: string;
  docsUrl?: string;
  status: import('./types.js').EdgeProviderStatus;
  configFields: import('./types.js').ConfigField[];
}> {
  return Object.values(REGISTRY).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    docsUrl: p.docsUrl,
    status: p.status,
    configFields: p.configFields,
  }));
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
