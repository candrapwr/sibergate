import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { getDb } from './db.js';

/**
 * Admin panel authentication: password hashing (scrypt) + stateless sessions
 * (HMAC-signed cookie).
 *
 * Design:
 *   - Passwords hashed with Node's builtin scrypt (no native deps). Stored as
 *     "scrypt:<N>:<salt_hex>:<hash_hex>".
 *   - Sessions are stateless: the cookie holds "base64(userId).hmac(userId)".
 *     Verifying recomputes the HMAC over the userId with SIBERGATE_SESSION_SECRET.
 *     Revoking all sessions = rotate the secret. No sessions table needed.
 *   - Users live in the gateway SQLite `users` table (multi-user UI gate; the
 *     admin API key still authorizes gateway calls separately).
 */

/* ─────────────────────────── password hashing ──────────────────────────── */

const SCRYPT_N = 16384; // cost factor (CPU/memory)
const KEY_LEN = 64; // derived key length in bytes
const SALT_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt:${SCRYPT_N}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  const hash = scryptSync(password, salt, expected.length, { N });
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/* ───────────────────────────── session (HMAC) ──────────────────────────── */

export const SESSION_COOKIE = 'sibergate_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, in seconds

function sessionSecret(): string {
  const secret = process.env.SIBERGATE_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SIBERGATE_SESSION_SECRET is not set (needs >= 16 chars). Set it in .env.');
  }
  return secret;
}

/** Sign a userId into a cookie value: "base64(userId).hmac". */
export function signSession(userId: string): string {
  const b64 = Buffer.from(userId).toString('base64url');
  const sig = createHmac('sha256', sessionSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/** Verify a cookie value and return the userId, or null if invalid/tampered. */
export function verifySession(cookieValue: string | undefined | null): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf('.');
  if (dot === -1) return null;
  const b64 = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', sessionSecret()).update(b64).digest('base64url');
  // constant-time compare of the signatures
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Build a Set-Cookie header value for a logged-in session. */
export function sessionCookieHeader(userId: string): string {
  return `${SESSION_COOKIE}=${signSession(userId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

/** Build a Set-Cookie header value that clears the session. */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/* ─────────────────────────────── user CRUD ─────────────────────────────── */

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
}

function toSafe(row: any): SafeUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
  };
}

/** Find a user by email (with password hash). Returns null if not found. */
export function findUserByEmail(email: string): (User & { passwordHash: string }) | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as any;
  if (!row) return null;
  return { ...toSafe(row), passwordHash: row.password_hash, createdAt: row.created_at };
}

/** Find a safe (no hash) user by id. */
export function findUserById(id: string): SafeUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  return row ? toSafe(row) : null;
}

/** Create a user with a hashed password. Throws on duplicate email. */
export function createUser(opts: { email: string; name: string; password: string; role?: string }): SafeUser {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    )
    .run(id, opts.email.toLowerCase(), opts.name, hashPassword(opts.password), opts.role ?? 'admin');
  return findUserById(id)!;
}

/** Stamp last_login_at = now for a user. */
export function touchLogin(id: string): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

/** Count users (used to decide whether to auto-seed the first admin). */
export function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
}

/** Verify email+password and return the safe user, or null. */
export function authenticate(email: string, password: string): SafeUser | null {
  const user = findUserByEmail(email);
  if (!user || user.status !== 'active') return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  touchLogin(user.id);
  const safe = findUserById(user.id)!;
  return safe;
}

/* ──────────────────── user management (admin) ─────────────────────────── */

/** List all users (safe — no password hashes). */
export function listUsers(): SafeUser[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as any[]).map(toSafe);
}

/** Delete a user by id. Returns true if a row was removed. */
export function deleteUser(id: string): boolean {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/** Enable or disable a user. */
export function setUserStatus(id: string, status: 'active' | 'disabled'): boolean {
  return (
    getDb()
      .prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id).changes > 0
  );
}

/** Update a user's name and/or role (password left untouched when omitted). */
export function updateUser(
  id: string,
  patch: { name?: string; role?: string; password?: string },
): SafeUser | null {
  const existing = findUserById(id);
  if (!existing) return null;
  const name = patch.name ?? existing.name;
  const role = patch.role ?? existing.role;
  if (patch.password !== undefined) {
    getDb()
      .prepare("UPDATE users SET name = ?, role = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, role, hashPassword(patch.password), id);
  } else {
    getDb()
      .prepare("UPDATE users SET name = ?, role = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, role, id);
  }
  return findUserById(id)!;
}
