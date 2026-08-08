/**
 * Edge Relays standalone CRUD — deploy sekali, reuse di pool mana saja.
 * Mirror pola proxy admin.ts (pool CRUD) + edge provider registry.
 *
 * Edge relay entity terpisah dari pool members. Member edge-relay reference
 * edge_relay_id (FK). Config (CF token, accountId, scriptName) di-encrypt di
 * edge_relays.config. Verify/deploy/remove operasi pada edge_relays langsung.
 */
import { getDb } from '../db.js';
import { encryptJSON, decryptJSON } from '../crypto.js';
import { ValidationError } from '../admin.js';
import { getEdgeProvider } from './edge/index.js';
import { redactProxyUrl } from './health.js';

export interface EdgeRelay {
  id: string;
  name: string;
  type: string;
  label: string | null;
  relayUrl: string | null;
  healthy: boolean;
  country: string | null;
  lastCheckAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Config tidak di-return (secret). hasConfig = true bila ada. */
  hasConfig: boolean;
}

interface EdgeRelayRow {
  id: string;
  name: string;
  type: string;
  label: string | null;
  config: string | null;
  relay_url: string | null;
  healthy: number;
  country: string | null;
  last_check_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toRelay(row: EdgeRelayRow): EdgeRelay {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    label: row.label,
    relayUrl: row.relay_url,
    healthy: row.healthy === 1,
    country: row.country,
    lastCheckAt: row.last_check_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasConfig: !!row.config,
  };
}

function assertValidId(id: string): void {
  if (!id || !id.trim()) throw new ValidationError('Edge relay id wajib diisi.');
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    throw new ValidationError('Id harus huruf, angka, hyphen, atau underscore.');
  }
}

/* ─────────────────────────────── CRUD ─────────────────────────────── */

export interface EdgeRelayInput {
  id: string;
  name?: string;
  type?: string;
  label?: string;
  enabled?: boolean;
}

export function createEdgeRelay(input: EdgeRelayInput): EdgeRelay {
  assertValidId(input.id);
  try {
    getDb()
      .prepare(
        `INSERT INTO edge_relays (id, name, type, label, enabled)
         VALUES (@id, @name, @type, @label, @enabled)`,
      )
      .run({
        id: input.id,
        name: input.name?.trim() || input.id,
        type: input.type ?? 'cloudflare-workers',
        label: input.label ?? null,
        enabled: input.enabled === false ? 0 : 1,
      });
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE')) {
      throw new ValidationError(`Edge relay '${input.id}' already exists.`);
    }
    throw err;
  }
  return getEdgeRelay(input.id)!;
}

export function updateEdgeRelay(id: string, input: Partial<EdgeRelayInput>): EdgeRelay | null {
  const existing = getEdgeRelay(id);
  if (!existing) return null;
  getDb()
    .prepare(
      `UPDATE edge_relays SET name = @name, label = @label, enabled = @enabled, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({
      id,
      name: input.name ?? existing.name,
      label: input.label !== undefined ? input.label : existing.label,
      enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
    });
  return getEdgeRelay(id);
}

export function getEdgeRelay(id: string): EdgeRelay | null {
  const row = getDb().prepare('SELECT * FROM edge_relays WHERE id = ?').get(id) as EdgeRelayRow | undefined;
  return row ? toRelay(row) : null;
}

export function listEdgeRelays(): EdgeRelay[] {
  return (getDb().prepare('SELECT * FROM edge_relays ORDER BY created_at ASC').all() as EdgeRelayRow[]).map(toRelay);
}

export function deleteEdgeRelay(id: string): boolean {
  const db = getDb();
  // Best-effort: hapus Worker deployment bila ada.
  const config = getRelayConfig(id);
  if (config?.relayUrl) {
    try {
      const provider = getEdgeProvider(getEdgeRelay(id)?.type ?? 'cloudflare-workers');
      void provider.remove(config).catch(() => {});
    } catch { /* ignore */ }
  }
  // Hapus pool member yg reference relay ini (edge_relay_id). Tanpa ini, member
  // jadi orphan saat relay dihapus — masih muncul di list pool tapi proxy-nya
  // tidak valid lagi (relay_id dangling). Member edge-relay hanya reference
  // (URL/config ada di edge_relays), jadi aman dihapus bersama relay.
  db.prepare('DELETE FROM proxy_pool_members WHERE edge_relay_id = ?').run(id);
  const res = db.prepare('DELETE FROM edge_relays WHERE id = ?').run(id);
  return res.changes > 0;
}

/* ─────────────────────────── Config (encrypted) ──────────────────── */

/** Ambil config relay (decrypted). */
export function getRelayConfig(id: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT config FROM edge_relays WHERE id = ?').get(id) as { config: string | null } | undefined;
  if (!row?.config) return null;
  try {
    return decryptJSON<Record<string, unknown>>(JSON.parse(row.config) as import('../crypto.js').EncryptedBlob);
  } catch {
    return null;
  }
}

/** Simpan config relay (encrypted). */
export function setRelayConfig(id: string, config: Record<string, unknown>): void {
  const blob = JSON.stringify(encryptJSON(config));
  getDb().prepare('UPDATE edge_relays SET config = ? WHERE id = ?').run(blob, id);
}

/** Set relay URL (setelah deploy). Sync URL baru ke semua pool member yg
 *  mereferensikan relay ini, supaya resolver baca URL terbaru (bukan snapshot
 *  saat member dibuat). Tanpa ini, member pakai URL lama setelah redeploy. */
export function setRelayUrl(id: string, url: string): void {
  const db = getDb();
  db.prepare('UPDATE edge_relays SET relay_url = ?, healthy = 1, updated_at = datetime(\'now\') WHERE id = ?').run(url, id);
  // Propagate URL + proxy_url (proxy_url dipakai logging) ke member reference.
  db.prepare('UPDATE proxy_pool_members SET relay_url = ?, proxy_url = ? WHERE edge_relay_id = ?').run(url, url, id);
}

/** Clear relay URL (setelah remove). Sync ke member reference juga. */
export function clearRelayUrl(id: string): void {
  const db = getDb();
  db.prepare('UPDATE edge_relays SET relay_url = NULL, healthy = 0 WHERE id = ?').run(id);
  db.prepare('UPDATE proxy_pool_members SET relay_url = NULL, healthy = 0 WHERE edge_relay_id = ?').run(id);
}

/* ─────────────────────── Edge actions (verify/deploy/remove/test) ── */

/** Verifikasi kredensial (mis. CF token). Simpan config encrypted bila sukses. */
export async function verifyEdgeRelay(
  id: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; accountInfo?: unknown; error?: string }> {
  const relay = getEdgeRelay(id);
  if (!relay) return { ok: false, error: 'Edge relay tidak ditemukan.' };
  const provider = getEdgeProvider(relay.type);
  const errors = provider.validateConfig(config);
  if (errors.length > 0) return { ok: false, error: errors[0] };
  const result = await provider.verifyCredentials(config);
  if (result.ok) {
    setRelayConfig(id, config);
  }
  return result;
}

/** Deploy relay (mis. CF Worker). Simpan relay_url bila sukses. */
export async function deployEdgeRelay(
  id: string,
  configOverride?: Record<string, unknown>,
): Promise<{ ok: boolean; relayUrl?: string; error?: string }> {
  const relay = getEdgeRelay(id);
  if (!relay) return { ok: false, error: 'Edge relay tidak ditemukan.' };
  const provider = getEdgeProvider(relay.type);
  // Merge: DB config sbg base, override dgn config dari UI. Validasi field
  // didelegasikan ke provider (tiap provider tahu field apa yg wajib — mis. CF
  // butuh accountId, Vercel/Deno/Netlify tidak). Wrapper tidak boleh berasumsi
  // field tertentu.
  const config = { ...(getRelayConfig(id) ?? {}), ...(configOverride ?? {}) };
  const errors = provider.validateConfig(config);
  if (errors.length > 0) return { ok: false, error: errors[0] };
  const result = await provider.deploy(config);
  if (result.ok && result.relayUrl) {
    setRelayConfig(id, config);
    setRelayUrl(id, result.relayUrl);
  }
  return result;
}

/** Hapus deployment (Worker). */
export async function removeEdgeRelayDeployment(id: string): Promise<{ ok: boolean; error?: string }> {
  const relay = getEdgeRelay(id);
  if (!relay) return { ok: false, error: 'Edge relay tidak ditemukan.' };
  const provider = getEdgeProvider(relay.type);
  const config = getRelayConfig(id) ?? {};
  const result = await provider.remove(config);
  if (result.ok) {
    clearRelayUrl(id);
  }
  return result;
}

/** Test connectivity relay (GET relay/__health). */
export async function testEdgeRelay(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const relay = getEdgeRelay(id);
  if (!relay || !relay.relayUrl) return { ok: false, latencyMs: 0, error: 'Relay belum di-deploy.' };
  const provider = getEdgeProvider(relay.type);
  const result = await provider.testConnectivity(relay.relayUrl);
  // Update health.
  getDb().prepare('UPDATE edge_relays SET healthy = ?, last_check_at = datetime(\'now\') WHERE id = ?')
    .run(result.ok ? 1 : 0, id);
  return result;
}
