import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

/**
 * Global console log bus — a real-time, in-memory event stream for the admin
 * "Console" panel. Unlike the SQLite `requests` table (which only records
 * completed proxied requests), this captures EVERYTHING as it happens:
 * incoming requests, auth failures, routing/failover steps, config changes,
 * and system lifecycle events.
 *
 * The bus lives in core (not the gateway) so that core modules which have no
 * Hono Context (e.g. logger.ts, engine.ts) can emit directly. Both core and
 * gateway already import from `@sibergate/core`.
 *
 * Storage is a fixed-size ring buffer in RAM — fast, zero DB writes, and
 * intentionally ephemeral (cleared on restart). New SSE subscribers first
 * receive the buffer snapshot, then live events as they are pushed.
 */

export type ConsoleLogLevel = 'info' | 'success' | 'warn' | 'error';

export type ConsoleLogCategory =
  | 'request'
  | 'auth'
  | 'routing'
  | 'config'
  | 'system'
  | 'incoming'
  | 'upstream';

export interface ConsoleLogEntry {
  /** Stable unique id (used as React key + dedupe on reconnect). */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  level: ConsoleLogLevel;
  category: ConsoleLogCategory;
  message: string;
  /** Structured payload (requestId, status, provider, trail, …). */
  details?: Record<string, unknown>;
}

const EVENT_NAME = 'log';

function readBufferSize(): number {
  const raw = process.env.SIBERGATE_CONSOLE_BUFFER;
  if (raw === undefined || raw === '') return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

class ConsoleLogBus extends EventEmitter {
  private buffer: ConsoleLogEntry[] = [];
  private readonly max: number;

  constructor() {
    super();
    // A single bus fans out to many SSE subscribers; allow more listeners
    // than the default 10 without Node printing a warning.
    this.setMaxListeners(50);
    this.max = readBufferSize();
  }

  /** Current ring-buffer snapshot (oldest → newest). */
  snapshot(): ConsoleLogEntry[] {
    return [...this.buffer];
  }

  /**
   * Push a log entry. Fire-and-forget: never throws into the request path
   * (mirrors the logRequest contract). Returns the created entry so callers
   * may reference it.
   */
  push(
    level: ConsoleLogLevel,
    category: ConsoleLogCategory,
    message: string,
    details?: Record<string, unknown>,
  ): ConsoleLogEntry {
    let entry: ConsoleLogEntry | null = null;
    try {
      entry = {
        id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
        ts: Date.now(),
        level,
        category,
        message,
        details,
      };
      this.buffer.push(entry);
      // Trim to size (ring buffer semantics — drop oldest).
      if (this.buffer.length > this.max) {
        this.buffer.splice(0, this.buffer.length - this.max);
      }
      this.emit(EVENT_NAME, entry);
    } catch {
      /* swallow — logging must never break the request */
    }
    return entry!;
  }
}

const bus = new ConsoleLogBus();

/**
 * Push a console log entry (the main entry point used by every hook point).
 */
export function pushConsoleLog(
  level: ConsoleLogLevel,
  category: ConsoleLogCategory,
  message: string,
  details?: Record<string, unknown>,
): ConsoleLogEntry {
  return bus.push(level, category, message, details);
}

/** Read the in-memory ring-buffer snapshot (for SSE initial burst). */
export function recentConsoleLogs(): ConsoleLogEntry[] {
  return bus.snapshot();
}

/**
 * Subscribe to live log events. Returns an unsubscribe function.
 * The listener receives only NEW entries pushed after subscribing — pair with
 * `recentConsoleLogs()` to seed the initial view.
 */
export function subscribeConsoleLogs(
  listener: (entry: ConsoleLogEntry) => void,
): () => void {
  bus.on(EVENT_NAME, listener);
  return () => bus.off(EVENT_NAME, listener);
}
