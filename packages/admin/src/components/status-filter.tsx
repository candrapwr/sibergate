'use client';

/**
 * Reusable status filter (all / enabled / disabled).
 *
 * Used by the Providers, Models, Routes, API Keys, and Users tables to narrow
 * the list by enabled state. The Users table maps `status==='active'` to
 * enabled — that mapping lives in each page, this component just takes a value.
 */
export type StatusFilterValue = 'all' | 'enabled' | 'disabled';

export function StatusFilter({
  value,
  onChange,
}: {
  value: StatusFilterValue;
  onChange: (v: StatusFilterValue) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as StatusFilterValue)}
      className="h-9 rounded-md border border-border bg-background px-2 text-[12px]"
    >
      <option value="all">all status</option>
      <option value="enabled">enabled only</option>
      <option value="disabled">disabled only</option>
    </select>
  );
}
