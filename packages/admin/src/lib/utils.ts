import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge tailwind classes (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format milliseconds → "1.2s" / "234ms". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format USD cents/USD → "$1.23". Input is USD dollars here. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format integer with thousands separators. */
export function formatNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

/** Format a SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → short local time. */
export function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  // SQLite stores UTC without tz; append Z for correct parsing.
  const d = new Date(ts.endsWith('Z') ? ts : `${ts}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Percent with 1 decimal. */
export function formatPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}%`;
}
