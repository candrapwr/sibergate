/**
 * Edge Relay types — interface contract utk setiap edge relay provider
 * (Cloudflare Workers, Vercel Edge, Deno Deploy, Netlify, AWS Lambda@Edge, ...).
 *
 * Setiap provider implementasi interface ini; registry index.ts map id→impl.
 * Nambah provider = +1 file impl + 1 line di registry map (mirror pola ADAPTERS).
 */

/** ID provider edge relay yg didukung (extend saat nambah provider). */
export type EdgeProviderId =
  | 'cloudflare-workers'
  | 'vercel-edge'
  | 'deno-deploy'
  | 'netlify-edge';
// | 'aws-lambda-edge'  // future — arsitektur beda (IAM + Lambda + CloudFront)

/**
 * Status kematangan provider. Dipakai UI utk badge + enable/disable pilihan.
 * - active: siap pakai, API deploy jalan
 * - beta: implement ada tapi belum diverifikasi ekstensif
 * - coming-soon: belum ada impl, di-disabled di UI (placeholder)
 */
export type EdgeProviderStatus = 'active' | 'beta' | 'coming-soon';

/**
 * Metadata field config utk render form dinamis di UI. Didefinisikan per
 * provider. UI baca configFields[] → render input (label, type, placeholder,
 * helper). Key = nama field di config object yg dikirim ke verify/deploy.
 */
export interface ConfigField {
  /** Nama field di config object (mis. 'apiToken', 'projectId'). */
  key: string;
  /** Label display di UI. */
  label: string;
  /** Tipe input. password = masked. */
  type: 'text' | 'password';
  /** Placeholder input. */
  placeholder?: string;
  /** Wajib diisi? */
  required: boolean;
  /** Teks bantuan kecil di bawah input (mis. cara dapat token, permission). */
  helper?: string;
}

/** Runtime config utk request rewrite (dipakai sendUpstream). */
export interface EdgeRelayRuntime {
  /** URL relay tujuan (mis. Worker URL), TANPA path suffix. */
  url: string;
  /** Header utk inject ke request (mis. x-relay-target: providerOrigin). */
  injectHeaders: Record<string, string>;
}

/** Hasil verifikasi kredensial provider. */
export interface VerifyResult {
  ok: boolean;
  accountInfo?: unknown;
  error?: string;
}

/** Hasil deploy relay. */
export interface DeployResult {
  ok: boolean;
  relayUrl?: string;
  error?: string;
}

/** Hasil test connectivity relay. */
export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  exitIp?: string | null;
  error?: string;
}

/** Hasil hapus relay. */
export interface RemoveResult {
  ok: boolean;
  error?: string;
}

/**
 * Contract tiap edge relay provider. Tiap provider (CF, Vercel, ...) implement
 * interface ini. Registry index.ts map EdgeProviderId → EdgeRelayProvider.
 */
export interface EdgeRelayProvider {
  /** ID unik (key di registry). */
  id: EdgeProviderId;
  /** Nama display utk UI. */
  displayName: string;
  /** Deskripsi singkat utk info panel/kartu UI (apa itu, keunggulan). */
  description: string;
  /** Link dokumentasi resmi provider (utk tombol "Learn more" di UI). */
  docsUrl?: string;
  /** Status kematangan. coming-soon = di-disabled di UI. */
  status: EdgeProviderStatus;
  /** Field config utk render form dinamis di UI. */
  configFields: ConfigField[];

  /** Validasi config user input. Return [] jika OK, array pesan error jika salah. */
  validateConfig(config: Record<string, unknown>): string[];

  /** Verifikasi kredensial (mis. CF token → GET /accounts). */
  verifyCredentials(config: Record<string, unknown>): Promise<VerifyResult>;

  /** Deploy relay (mis. CF Worker via PUT multipart). Return URL relay. */
  deploy(config: Record<string, unknown>): Promise<DeployResult>;

  /** Hapus relay (DELETE Worker script). */
  remove(config: Record<string, unknown>): Promise<RemoveResult>;

  /** Test connectivity relay (GET relay/__health). */
  testConnectivity(relayUrl: string): Promise<ConnectivityResult>;

  /**
   * Bangun runtime config utk rewrite request (dipakai sendUpstream).
   * decryptedConfig = hasil decrypt edge_config dr DB (berisi token, dll).
   * providerOrigin = origin provider tujuan (mis. https://api.openai.com).
   */
  buildRelayConfig(decryptedConfig: Record<string, unknown>, providerOrigin: string): EdgeRelayRuntime;
}
