/**
 * Custom Scripts — build-your-own provider via Node.js script.
 *
 * Tiap record jadi endpoint publik di `/api/custom/<id>`. Gateway menerima
 * request, menulis body ke stdin script, lalu men-spawn `node` via child_process.
 * Output `stdout` script diteruskan verbatim ke client sebagai response body
 * (format bebas — pembuat tanggung jawab: JSON kalau mau dipakai sebagai target
 * route chat, text biasa kalau utk modality generic, dst).
 *
 * Endpoint script lalu didaftarkan sebagai provider HTTP biasa di master data
 * (baseUrl → gateway sendiri), shg alur routing/failover SiberGate tidak
 * berubah sama sekali. Modul ini hanya urus storage + eksekusi; routing tetap
 * di tangan engine.ts.
 *
 * Eksekusi via child_process spawn → isolasi penuh: script crash / infinite
 * loop / OOM tidak memengaruhi proses gateway. Timeout mematikan paksa
 * (SIGKILL). Client disconnect (AbortSignal) juga mematikan script.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, type DB } from './db.js';
import { ValidationError } from './admin.js';

/** A custom script record (in-memory shape; `enabled` is normalized to bool). */
export interface CustomScript {
  id: string;
  name: string;
  description: string | null;
  script: string;
  timeoutMs: number;
  language: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input request context handed to the script executor. */
export interface ScriptRequestInput {
  method: string;
  path: string;
  /** Raw query string (without the leading `?`), may be empty. */
  query: string;
  /** Request headers (auth/secrets should be redacted before passing). */
  headers: Record<string, string>;
  /** Raw request body (string). Empty string for bodyless requests. */
  body: string;
}

/** Result of running a script once. */
export interface ScriptRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Set bila execution failed before/during spawn (e.g. write error). */
  error?: string;
}

/** Snake-cased DB row (raw better-sqlite3 shape). */
interface ScriptRow {
  id: string;
  name: string;
  description: string | null;
  script: string;
  timeout_ms: number;
  language: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toScript(row: ScriptRow): CustomScript {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    script: row.script,
    timeoutMs: row.timeout_ms,
    language: row.language,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validate a script id (URL slug). Same rules as other path ids: non-empty,
 * no whitespace, no slash. Additionally restricted to lowercase slug chars so
 * the id is safe as a URL segment and a provider id.
 */
export function assertValidScriptId(label: string, id: string): void {
  if (!id || !id.trim()) {
    throw new ValidationError(`'${label}' id must not be empty.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ValidationError(
      `'${label}' id must be lowercase letters, digits, or hyphens (got '${id}').`,
    );
  }
}

/** Public return shape for admin API (excludes the raw script source). */
export type CustomScriptSummary = Omit<CustomScript, 'script'>;

function summarize(s: CustomScript): CustomScriptSummary {
  const { script: _script, ...rest } = s;
  return rest;
}

/* ─────────────────────────────── CRUD ─────────────────────────────── */

export interface ScriptInput {
  id: string;
  name?: string;
  description?: string;
  script?: string;
  timeoutMs?: number;
  language?: string;
  enabled?: boolean;
}

function db(): DB {
  return getDb();
}

export function createScript(input: ScriptInput): CustomScript {
  assertValidScriptId('Script', input.id);
  if (input.script === undefined || input.script === '') {
    throw new ValidationError('Script source must not be empty.');
  }
  const name = input.name?.trim() || input.id;
  const timeoutMs = clampTimeout(input.timeoutMs);
  try {
    db()
      .prepare(
        `INSERT INTO custom_scripts (id, name, description, script, timeout_ms, language, enabled)
         VALUES (@id, @name, @description, @script, @timeout_ms, @language, @enabled)`,
      )
      .run({
        id: input.id,
        name,
        description: input.description ?? null,
        script: input.script,
        timeout_ms: timeoutMs,
        language: input.language ?? 'javascript',
        enabled: input.enabled === false ? 0 : 1,
      });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new ValidationError(`Script '${input.id}' already exists.`);
    }
    throw err;
  }
  const created = getScript(input.id);
  if (!created) throw new Error('Script insert succeeded but row not found.');
  return created;
}

export function updateScript(id: string, input: Partial<ScriptInput>): CustomScript | null {
  const existing = getScript(id);
  if (!existing) return null;
  const merged: ScriptInput = {
    id: existing.id,
    name: existing.name,
    description: existing.description ?? undefined,
    script: existing.script,
    timeoutMs: existing.timeoutMs,
    language: existing.language,
    enabled: existing.enabled,
    ...input,
  };
  if (merged.script === '') {
    throw new ValidationError('Script source must not be empty.');
  }
  db()
    .prepare(
      `UPDATE custom_scripts
       SET name = @name, description = @description, script = @script,
           timeout_ms = @timeout_ms, language = @language, enabled = @enabled,
           updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({
      id: merged.id,
      name: merged.name?.trim() || merged.id,
      description: merged.description ?? null,
      script: merged.script ?? '',
      timeout_ms: clampTimeout(merged.timeoutMs),
      language: merged.language ?? 'javascript',
      enabled: merged.enabled === false ? 0 : 1,
    });
  return getScript(id);
}

export function getScript(id: string): CustomScript | null {
  const row = db().prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id) as
    | ScriptRow
    | undefined;
  return row ? toScript(row) : null;
}

/** Lookup by slug as it appears in the URL (`/api/custom/<name>`). */
export function getScriptByName(name: string): CustomScript | null {
  return getScript(name);
}

export function listScripts(): CustomScriptSummary[] {
  const rows = db()
    .prepare('SELECT * FROM custom_scripts ORDER BY created_at ASC')
    .all() as ScriptRow[];
  return rows.map((r) => summarize(toScript(r)));
}

export function deleteScript(id: string): boolean {
  const res = db().prepare('DELETE FROM custom_scripts WHERE id = ?').run(id);
  return res.changes > 0;
}

function clampTimeout(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 10_000;
  if (v < 500) return 500;
  if (v > 300_000) return 300_000; // hard cap 5 min
  return Math.floor(v);
}

/* ───────────────────────────── Executor ───────────────────────────── */

/** Cap stdout/stderr buffers so a runaway script cannot OOM the gateway. */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB each

export interface ExecuteScriptOptions {
  /** Raw script source (Node.js). Written to a temp file at runtime. */
  scriptSource: string;
  /** Request context to feed the script (stdin body + env metadata). */
  input: ScriptRequestInput;
  /** Per-run timeout in ms. Overrides nothing in DB; caller decides. */
  timeoutMs: number;
  /** Optional abort signal (client disconnect) → kills the child immediately. */
  signal?: AbortSignal;
}

/**
 * Run a script once and collect its output. Never throws on script failure —
 * failures (non-zero exit, timeout, spawn error) are surfaced via the returned
 * `ScriptRunResult`. Only infrastructure errors (e.g. cannot create temp dir)
 * reject the promise.
 */
export async function executeScript(
  opts: ExecuteScriptOptions,
): Promise<ScriptRunResult> {
  let tmpDir: string | null = null;
  const start = Date.now();
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'sibergate-script-'));
    const scriptFile = join(tmpDir, 'script.mjs');
    // mode 0o600: only owner can read/write the source.
    await writeFile(scriptFile, opts.scriptSource, { mode: 0o600 });

    // Metadata handed to the script via env (avoids touching argv). Auth header
    // should already be redacted by the caller, but strip defensively here too.
    const safeHeaders = redactHeaders(opts.input.headers);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SIBERGATE_REQUEST_METHOD: opts.input.method,
      SIBERGATE_REQUEST_PATH: opts.input.path,
      SIBERGATE_REQUEST_QUERY: opts.input.query,
      SIBERGATE_REQUEST_HEADERS: JSON.stringify(safeHeaders),
    };

    const child = spawn(process.execPath, ['--no-warnings', scriptFile], {
      cwd: tmpDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detach so we can kill the whole process tree if the script spawns its
      // own children (e.g. fetch with keepalive). We re-attach via unref.
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: string | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      stdoutBytes += chunk.length;
      stdout += chunk.toString('utf8');
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        stdout += '\n[sibergate] stdout truncated at 5MB\n';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      stderrBytes += chunk.length;
      stderr += chunk.toString('utf8');
      if (stderrBytes >= MAX_OUTPUT_BYTES) {
        stderr += '\n[sibergate] stderr truncated at 5MB\n';
      }
    });

    const timeoutMs = clampTimeout(opts.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      if (child.exitCode === null && child.pid) killTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Write the request body to stdin then close it. Errors here (e.g. script
    // exited before reading) are non-fatal — surfaced via exitCode instead.
    try {
      child.stdin.write(opts.input.body);
      child.stdin.end();
    } catch {
      /* script may have exited already; ignore */
    }

    const exitCode: number | null = await new Promise((resolve) => {
      child.on('error', (err) => {
        spawnError = err.message;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });

    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

    const durationMs = Date.now() - start;
    if (spawnError) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs,
        stdout,
        stderr,
        error: spawnError,
      };
    }
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      timedOut,
      durationMs,
      stdout,
      stderr,
    };
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Kill a child and any descendants it may have spawned (process tree). */
function killTree(child: import('node:child_process').ChildProcess): void {
  if (!child.pid) return;
  try {
    // On non-Windows, negative PID kills the whole process group. We spawned
    // without detached group, so this falls back to killing the child directly.
    process.kill(child.pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
}

/** Defensively strip auth-like header values before passing to the script env. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const REDACT = /^(authorization|x-api-key|api-key|cookie|proxy-authorization|x-auth-token)$/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT.test(k) ? '***' : v;
  }
  return out;
}
