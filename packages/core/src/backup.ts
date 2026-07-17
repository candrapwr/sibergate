import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './db.js';

/**
 * Backup & restore the entire SiberGate state for server migration.
 *
 * A backup bundles the SQLite DB file + the encryption master key into a single
 * portable file. Without the master key, encrypted provider credentials can't
 * be decrypted on the new server — so both must travel together.
 *
 * Backup format: a JSON file with base64-encoded db + key:
 *   { "version": 1, "createdAt": "...", "db": "<base64>", "masterKey": "<hex>" }
 * Saved as .sibergate-backup (or downloaded from the UI).
 */

const DB_PATH = () => process.env.SIBERGATE_DB ?? 'sibergate.db';
const KEY_PATH = () => resolve(process.cwd(), '.sibergate', 'master-key');

export interface BackupPayload {
  version: number;
  createdAt: string;
  db: string; // base64 of the SQLite file
  masterKey: string; // hex string
}

/**
 * Create a backup. Reads the DB file + master key, returns a JSON payload.
 * The DB connection is briefly checkpointed (WAL flush) so the file is consistent.
 */
export function createBackup(): BackupPayload {
  const dbPath = resolve(process.cwd(), DB_PATH());
  const keyPath = KEY_PATH();

  // Flush WAL so the .db file on disk is complete.
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best-effort */
  }

  if (!existsSync(dbPath)) throw new Error('Database file not found — nothing to back up.');
  if (!existsSync(keyPath)) throw new Error('Master key file not found — cannot back up credentials.');

  const dbBase64 = readFileSync(dbPath).toString('base64');
  const masterKey = readFileSync(keyPath, 'utf8').trim();

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    db: dbBase64,
    masterKey,
  };
}

/**
 * Restore from a backup payload. Overwrites the current DB file + master key,
 * then signals the caller to restart/reload.
 *
 * WARNING: this replaces ALL data. The caller should confirm with the user.
 */
export function restoreBackup(payload: BackupPayload): void {
  if (!payload.db || !payload.masterKey) {
    throw new Error('Invalid backup file: missing db or masterKey.');
  }

  const dbPath = resolve(process.cwd(), DB_PATH());
  const keyDir = resolve(process.cwd(), '.sibergate');
  const keyPath = KEY_PATH();

  // Close the current DB connection so we can overwrite the file safely.
  // (The caller should restart the process after restore.)
  try {
    getDb().close();
  } catch {
    /* may already be closed */
  }

  // Write the DB file.
  const dbBuffer = Buffer.from(payload.db, 'base64');
  writeFileSync(dbPath, dbBuffer);

  // Write the master key.
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(keyPath, payload.masterKey, { mode: 0o600 });
}

/** Serialize a backup to a JSON string (for file download). */
export function backupToJson(payload: BackupPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** Parse a backup JSON string (from file upload). */
export function parseBackup(json: string): BackupPayload {
  const parsed = JSON.parse(json) as Partial<BackupPayload>;
  if (!parsed.db || !parsed.masterKey) throw new Error('Invalid backup file format.');
  return parsed as BackupPayload;
}
