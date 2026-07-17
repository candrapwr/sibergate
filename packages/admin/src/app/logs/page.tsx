'use client';

import { useState, useMemo } from 'react';
import { ScrollText, X } from 'lucide-react';
import { useLogs, useProviders, useRoutes } from '@/lib/queries';
import type { RequestLog } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { formatMs, formatTs, formatUsd, formatNum } from '@/lib/utils';

export default function LogsPage() {
  const { data, isLoading } = useLogs(200);
  const { data: routesData } = useRoutes();
  const { data: providersData } = useProviders();
  const logs = data?.data ?? [];
  const [filter, setFilter] = useState({ status: '', route: '', provider: '', q: '' });
  const [selected, setSelected] = useState<RequestLog | null>(null);

  // Lookup maps: id → display name, so filter dropdowns show friendly labels.
  const routeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of routesData?.data ?? []) m.set(r.id, r.name);
    return m;
  }, [routesData]);
  const providerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providersData?.data ?? []) m.set(p.id, p.name);
    return m;
  }, [providersData]);

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (filter.status && String(l.status) !== filter.status) return false;
      if (filter.route && l.route !== filter.route) return false;
      if (filter.provider && l.provider !== filter.provider) return false;
      if (filter.q) {
        const hay = `${l.request_id} ${l.route} ${l.provider} ${l.model} ${l.error_message}`.toLowerCase();
        if (!hay.includes(filter.q.toLowerCase())) return false;
      }
      return true;
    });
  }, [logs, filter]);

  const routes = [...new Set(logs.map((l) => l.route).filter(Boolean))] as string[];
  const providers = [...new Set(logs.map((l) => l.provider).filter(Boolean))] as string[];

  return (
    <div className="space-y-6">
      <PageHeader title="Logs" subtitle="Recent requests — auto-refreshes every 10s" />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} className="h-9 rounded-md border border-border bg-background px-2 text-[12px]">
          <option value="">all status</option>
          <option value="200">200</option>
          <option value="401">401</option>
          <option value="404">404</option>
          <option value="429">429</option>
          <option value="502">502</option>
          <option value="504">504</option>
        </select>
        <select value={filter.route} onChange={(e) => setFilter({ ...filter, route: e.target.value })} className="h-9 rounded-md border border-border bg-background px-2 text-[12px]">
          <option value="">all routes</option>
          {routes.map((r) => <option key={r} value={r}>{routeNames.get(r) ?? r}</option>)}
        </select>
        <select value={filter.provider} onChange={(e) => setFilter({ ...filter, provider: e.target.value })} className="h-9 rounded-md border border-border bg-background px-2 text-[12px]">
          <option value="">all providers</option>
          {providers.map((p) => <option key={p} value={p}>{providerNames.get(p) ?? p}</option>)}
        </select>
        <Input value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder="Search…" className="h-9 w-48 text-[12px]" />
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-md bg-secondary/40" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={ScrollText} title="No requests yet" hint="Send a request via /v1/chat/completions to see logs." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((l) => (
              <TableRow key={l.id} className="cursor-pointer" onClick={() => setSelected(l)}>
                <TableCell className="whitespace-nowrap text-[12px] text-muted-foreground">{formatTs(l.ts)}</TableCell>
                <TableCell className="font-mono text-[12px]">{l.route ?? '—'}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">{l.provider ? `${l.provider}:${l.model}` : '—'}</TableCell>
                <TableCell><StatusBadge status={l.status} /></TableCell>
                <TableCell className="text-muted-foreground">{formatMs(l.latency_ms)}</TableCell>
                <TableCell className="text-muted-foreground">{l.total_tokens ? formatNum(l.total_tokens) : '—'}</TableCell>
                <TableCell className="text-muted-foreground">{formatUsd(l.cost_usd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selected && <DetailDrawer log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function StatusBadge({ status }: { status: number | null }) {
  if (status == null) return <Badge variant="muted">—</Badge>;
  if (status >= 200 && status < 300) return <Badge variant="success">{status}</Badge>;
  if (status === 429) return <Badge variant="warning">{status}</Badge>;
  if (status >= 500) return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="destructive">{status}</Badge>;
}

function DetailDrawer({ log, onClose }: { log: RequestLog; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative h-full w-full max-w-md overflow-y-auto border-l border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Request detail</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="space-y-2 text-[13px]">
          <Row label="Request ID" value={log.request_id ?? '—'} mono />
          <Row label="Time" value={formatTs(log.ts)} />
          <Row label="Method · Path" value={`${log.method ?? '—'} ${log.path ?? ''}`} mono />
          <Row label="Route" value={log.route ?? '—'} mono />
          <Row label="Strategy" value={log.strategy ?? '—'} />
          <Row label="Provider" value={log.provider ?? '—'} mono />
          <Row label="Model" value={log.model ?? '—'} mono />
          <Row label="Status" value={<StatusBadge status={log.status} />} />
          <Row label="Streamed" value={log.streamed ? 'yes' : 'no'} />
          <Row label="Latency" value={formatMs(log.latency_ms)} />
          <Row label="Tokens" value={`${formatNum(log.prompt_tokens)} in · ${formatNum(log.completion_tokens)} out · ${formatNum(log.total_tokens)} total`} />
          <Row label="Cost" value={formatUsd(log.cost_usd)} />
          <Row label="Client IP" value={log.client_ip ?? '—'} mono />
          {log.error_code && <Row label="Error code" value={log.error_code} mono />}
          {log.error_message && (
            <div className="pt-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Error</div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] text-destructive">
                {log.error_message}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</span>
    </div>
  );
}
