'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Shared client-side type for a console log entry. Mirrors the gateway's
 * ConsoleLogEntry (pushed over SSE). Declared here (not imported from core)
 * because the admin package is browser-bundled and must not pull @sibergate/core.
 */
export type ConsoleLogLevel = 'info' | 'success' | 'warn' | 'error';
export type ConsoleLogCategory =
  | 'request'
  | 'auth'
  | 'routing'
  | 'config'
  | 'system'
  | 'incoming'
  | 'upstream'
  | 'custom-script'
  | 'proxy';

export interface ConsoleLogEntry {
  id: string;
  ts: number;
  level: ConsoleLogLevel;
  category: ConsoleLogCategory;
  message: string;
  details?: Record<string, unknown>;
}

export type ConsoleStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

/** Cap the in-DOM log list so a long-running tab stays responsive. */
const MAX_LOGS = 1000;

/**
 * Subscribe to the gateway's live console stream via SSE.
 *
 * The browser opens `EventSource('/api/admin/logs/stream')`, which the Next.js
 * proxy forwards to `/admin/logs/stream` (injecting the admin key server-side).
 * The gateway first sends the ring-buffer snapshot, then live events. On
 * disconnect, EventSource auto-reconnects (browser-native backoff).
 */
export function useConsoleStream() {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [status, setStatus] = useState<ConsoleStatus>('connecting');
  const [count, setCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Accumulate a running total across reconnects so the counter reflects
    // everything seen since mount (not just the current buffer contents).
    let total = 0;
    let connected = false;

    const open = () => {
      const es = new EventSource('/api/admin/logs/stream', { withCredentials: true });
      eventSourceRef.current = es;

      es.onopen = () => {
        connected = true;
        setStatus('live');
      };

      es.onmessage = (ev) => {
        let entry: ConsoleLogEntry | null = null;
        try {
          entry = JSON.parse(ev.data) as ConsoleLogEntry;
        } catch {
          return; // ignore malformed frames (e.g. heartbeat comments are not onmessage)
        }
        if (!entry || !entry.id) return;
        total += 1;
        setCount(total);
        setLogs((prev) => {
          // Dedupe by id (snapshot after a reconnect can re-send buffered items).
          if (prev.some((p) => p.id === entry!.id)) return prev;
          const next = prev.length >= MAX_LOGS ? prev.slice(prev.length - MAX_LOGS + 1) : prev;
          return [...next, entry!];
        });
      };

      es.onerror = () => {
        setStatus(connected ? 'reconnecting' : 'error');
        // EventSource will auto-reconnect; onopen flips status back to 'live'.
      };
    };

    open();

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  /** Clear the visible log list (local only; the gateway buffer is unaffected). */
  const clear = useCallback(() => {
    setLogs([]);
  }, []);

  return { logs, status, count, clear };
}
