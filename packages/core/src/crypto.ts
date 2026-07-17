import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * AES-256-GCM encryption for provider credentials stored in SQLite.
 *
 * Master key handling is deliberately simple (single-user, self-hosted):
 *   - If SIBERGATE_MASTER_KEY env is set (64 hex chars), use it.
 *   - Else load from <cwd>/.sibergate/master-key (created on first run).
 *   - Else generate one and persist it.
 *
 * The key file is NOT committed (gitignored). Credentials are decrypted only
 * transiently in memory at request time and never logged.
 */

const KEY_FILE = resolve(process.cwd(), '.sibergate', 'master-key');

function loadOrCreateKey(): Buffer {
  const fromEnv = process.env.SIBERGATE_MASTER_KEY;
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    return Buffer.from(fromEnv, 'hex');
  }
  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  }
  // Generate + persist.
  const key = randomBytes(32);
  mkdirSync(resolve(KEY_FILE, '..'), { recursive: true });
  writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  console.log(`[sibergate] generated new master key at ${KEY_FILE}`);
  return key;
}

const KEY = loadOrCreateKey();
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

export interface EncryptedBlob {
  iv: string; // base64
  ct: string; // base64
  tag: string; // base64
}

/** Encrypt a JSON-serializable value. */
export function encryptJSON(plaintext: unknown): EncryptedBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const data = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

/** Decrypt a blob. Throws if tampered (GCM auth fails). */
export function decryptJSON<T = unknown>(blob: EncryptedBlob): T {
  const iv = Buffer.from(blob.iv, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(data.toString('utf8')) as T;
}

/** sha256 hex (for API key hashing). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
