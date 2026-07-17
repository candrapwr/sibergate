'use client';

import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Client-side pagination controls.
 *
 * Pure presentational: the caller owns the `page`, `pageSize`, and the already-
 * sliced rows. This component just renders the prev/next/first/last buttons, a
 * compact page-number window, the page-size selector, and the "X–Y of Z" count.
 *
 * Designed for tables that load everything up front (the gateway's list
 * endpoints already return the full set) so we avoid server-side paging work.
 */

export interface PaginationProps {
  /** Zero-based current page. */
  page: number;
  /** Items per page. */
  pageSize: number;
  /** Total item count (before slicing). */
  total: number;
  /** Called when the user navigates to a page (0-based). */
  onPageChange: (page: number) => void;
  /** Called when the user changes the page size. */
  onPageSizeChange?: (size: number) => void;
  /** Optional label, e.g. "providers". */
  itemName?: string;
  /** Page size options in the selector. */
  pageSizeOptions?: number[];
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  itemName = 'items',
  pageSizeOptions = [10, 25, 50, 100],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const start = total === 0 ? 0 : safePage * pageSize + 1;
  const end = Math.min((safePage + 1) * pageSize, total);

  // Keep the caller's page in range when the data shrinks (e.g. after a filter
  // or delete) so the table doesn't land on an empty page.
  useEffect(() => {
    if (page > totalPages - 1) onPageChange(Math.max(0, totalPages - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages, page]);

  // Build a compact window of page numbers around the current page (always
  // include first + last, with an ellipsis gap when there's a jump).
  const pages = pageWindow(safePage, totalPages);

  const go = (p: number) => onPageChange(Math.max(0, Math.min(p, totalPages - 1)));

  if (total === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[12px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>
          {start}–{end} of {total} {itemName}
        </span>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span className="hidden sm:inline">Rows</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px]"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => go(0)} disabled={safePage === 0} title="First page">
          <ChevronsLeft size={14} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => go(safePage - 1)} disabled={safePage === 0} title="Previous page">
          <ChevronLeft size={14} />
        </Button>

        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="px-1 text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => go(p)}
              className={`h-7 min-w-7 rounded-md border px-2 text-[12px] transition-colors ${
                p === safePage
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-foreground hover:bg-secondary'
              }`}
            >
              {p + 1}
            </button>
          ),
        )}

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => go(safePage + 1)} disabled={safePage >= totalPages - 1} title="Next page">
          <ChevronRight size={14} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => go(totalPages - 1)} disabled={safePage >= totalPages - 1} title="Last page">
          <ChevronsRight size={14} />
        </Button>
      </div>
    </div>
  );
}

/**
 * Compute the page-number window to show: first, last, current, and one
 * neighbour on each side, with '…' markers for gaps. Returns numbers (0-based)
 * and '…' strings.
 */
function pageWindow(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out: Array<number | '…'> = [0];
  const from = Math.max(1, current - 1);
  const to = Math.min(total - 2, current + 1);
  if (from > 1) out.push('…');
  for (let p = from; p <= to; p++) out.push(p);
  if (to < total - 2) out.push('…');
  out.push(total - 1);
  return out;
}
