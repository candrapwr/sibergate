'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Terminal,
  Trash2,
  ChevronRight,
  ChevronDown,
  ArrowDown,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { useConsoleStream, type ConsoleLogEntry, type ConsoleLogCategory } from '@/lib/use-console-stream';
import { cn } from '@/lib/utils';

/**
 * Live console — a terminal-style real-time view of ALL gateway events
 * (requests, auth failures, routing/failover, config changes, system).
 *
 * Fed by an SSE stream from /admin/logs/stream. Auto-scrolls to the latest
 * line unless the user scrolls up (then a "jump to latest" button appears).
 */

const CATEGORIES: ConsoleLogCategory[] = ['incoming', 'routing', 'upstream', 'request', 'auth', 'config', 'system'];

const STATUS_META: Record<string, { dot: string; label: string; text: string }> = {
  live: { dot: 'bg-success animate-pulse', label: 'Live', text: 'text-success' },
  connecting: { dot: 'bg-muted-foreground animate-pulse', label: 'Connecting', text: 'text-muted-foreground' },
  reconnecting: { dot: 'bg-warning animate-pulse', label: 'Reconnecting', text: 'text-warning' },
  error: { dot: 'bg-destructive', label: 'Error', text: 'text-destructive' },
};

const LEVEL_TEXT: Record<string, string> = {
  success: 'text-success',
  info: 'text-primary',
  warn: 'text-warning',
  error: 'text-destructive',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export default function ConsolePage() {
  const { logs, status, count, clear } = useConsoleStream();
  const [active, setActive] = useState<Set<ConsoleLogCategory>>(new Set(CATEGORIES));
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filter by active categories (All ⇄ none toggles the whole set).
  const filtered = useMemo(() => {
    return active.size === 0 ? [] : logs.filter((l) => active.has(l.category));
  }, [logs, active]);

  // Auto-scroll to bottom when new lines arrive (unless paused or user scrolled up).
  useEffect(() => {
    if (!autoScroll || paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll, paused]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }, []);

  const toggleCat = (cat: ConsoleLogCategory) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleAll = () => {
    setActive((prev) => (prev.size === CATEGORIES.length ? new Set() : new Set(CATEGORIES)));
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const statusMeta = STATUS_META[status] ?? STATUS_META.connecting;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col space-y-3">
      <PageHeader
        title="Console"
        subtitle="Live gateway event stream — requests, routing, auth, config"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={cn('h-2 w-2 rounded-full', statusMeta.dot)} />
              <span className={statusMeta.text}>{statusMeta.label}</span>
            </div>
            <span className="text-[12px] text-muted-foreground">{count} events</span>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className={cn(
                'rounded-md border border-border px-2 py-1 text-[11px] hover:bg-secondary',
                paused ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={clear}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary"
            >
              <Trash2 size={11} /> Clear
            </button>
          </div>
        }
      />

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={toggleAll}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
            active.size === CATEGORIES.length
              ? 'border-primary/40 bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:bg-secondary',
          )}
        >
          All
        </button>
        {CATEGORIES.map((cat) => {
          const on = active.has(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => toggleCat(cat)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors',
                on ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-secondary',
              )}
            >
              {cat}
            </button>
          );
        })}
      </div>

      {/* Terminal body */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-[hsl(220_13%_6%)]">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed"
        >
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
              <Terminal size={28} strokeWidth={1.5} className="mb-3" />
              <p className="text-[13px]">
                {logs.length === 0
                  ? 'Menunggu event…'
                  : 'Tidak ada event untuk filter ini.'}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                Kirim request via /v1/* atau ubah config untuk melihat log muncul di sini.
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((log) => (
                <LogLine
                  key={log.id}
                  log={log}
                  expanded={expanded.has(log.id)}
                  onToggle={() => toggleExpand(log.id)}
                  paused={paused}
                />
              ))}
            </div>
          )}
        </div>

        {/* Jump to latest */}
        {!autoScroll && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/95 px-3 py-1 text-[11px] shadow-lg hover:bg-secondary"
          >
            <ArrowDown size={11} /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

function LogLine({
  log,
  expanded,
  onToggle,
  paused,
}: {
  log: ConsoleLogEntry;
  expanded: boolean;
  onToggle: () => void;
  paused: boolean;
}) {
  const hasDetails = !!log.details && Object.keys(log.details).length > 0;
  return (
    <div className="group">
      <div
        className={cn(
          'flex items-start gap-2 rounded px-1 py-0.5 hover:bg-secondary/40',
          paused && 'opacity-90',
        )}
      >
        <span className="shrink-0 tabular-nums text-muted-foreground/60">{fmtTime(log.ts)}</span>
        <span className={cn('shrink-0 uppercase tracking-wide', LEVEL_TEXT[log.level])}>
          [{log.category}]
        </span>
        <button
          type="button"
          onClick={onToggle}
          className={cn('flex flex-1 items-start gap-1 text-left', hasDetails ? 'cursor-pointer' : 'cursor-default')}
        >
          {hasDetails ? (
            expanded ? (
              <ChevronDown size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
            )
          ) : null}
          <span className="break-all">{log.message}</span>
        </button>
      </div>
      {expanded && hasDetails && (
        <pre className="ml-[8.5rem] mt-0.5 mb-1 max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] text-muted-foreground">
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
