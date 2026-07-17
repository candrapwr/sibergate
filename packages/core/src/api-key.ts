import { randomBytes } from 'node:crypto';
import { sha256Hex } from './crypto.js';

/**
 * Client API key generation & hashing.
 *
 * Format: sg_live_<32 base62 chars>. Plaintext shown ONCE at seed/creation;
 * only the sha256 hash is stored in the api_keys table.
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

export interface GeneratedKey {
  /** Full plaintext — show once, never store. */
  plaintext: string;
  /** sha256 hex — store in api_keys.key_hash. */
  hash: string;
  /** Display prefix, e.g. "sg_live_ab12…". */
  prefix: string;
}

export function generateApiKey(): GeneratedKey {
  const rand = base62(randomBytes(24));
  const plaintext = `sg_live_${rand}`;
  return { plaintext, hash: sha256Hex(plaintext), prefix: plaintext.slice(0, 14) };
}

/** Hash an incoming Bearer token for DB lookup. */
export function hashApiKey(plaintext: string): string {
  return sha256Hex(plaintext);
}

/** Strip "Bearer " prefix. Returns null if absent/malformed. */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const t = header.trim();
  if (!t.toLowerCase().startsWith('bearer ')) return null;
  const token = t.slice(7).trim();
  return token.length > 0 ? token : null;
}
