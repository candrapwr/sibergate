'use client';

import { Network } from 'lucide-react';
import { useProxyLogs } from '@/lib/queries';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function flagEmoji(iso: string | null | undefined): string {
  if (!iso || iso.length !== 2) return '🏳️';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  return String.fromCodePoint(A + (iso.charCodeAt(0) - base), A + (iso.charCodeAt(1) - base));
}

const OUTCOME_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'muted' | 'default'> = {
  served: 'success',
  recovered: 'success',
  selected: 'default',
  failed: 'destructive',
  unhealthy: 'warning',
  timeout: 'warning',
};

export default function ProxyLogsPage() {
  const { data, isLoading } = useProxyLogs(200);
  const logs = data?.data ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader title="Proxy Logs" subtitle="Event proxy: selection, served, failed, health state. Refresh otomatis tiap 10s." />
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-border bg-secondary/20" />
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
          <Network size={28} className="mb-3 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm font-medium">Belum ada event proxy</p>
          <p className="mt-1 text-[13px] text-muted-foreground">Bind provider ke pool & buat request utk melihat log.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Time</TableHead>
                <TableHead className="w-[110px]">Outcome</TableHead>
                <TableHead>Proxy / Provider</TableHead>
                <TableHead className="w-[90px]">Country</TableHead>
                <TableHead className="w-[80px]">Latency</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{l.ts}</TableCell>
                  <TableCell>
                    <Badge variant={OUTCOME_VARIANT[l.outcome] ?? 'muted'}>{l.outcome}</Badge>
                  </TableCell>
                  <TableCell className="text-[12px]">
                    <div className="font-mono">{l.memberUrl ?? '—'}</div>
                    <div className="text-[10px] text-muted-foreground">pool: {l.poolId ?? '—'} · provider: {l.providerId ?? '—'}</div>
                  </TableCell>
                  <TableCell>{flagEmoji(l.country)}<span className="ml-1 text-[11px] text-muted-foreground">{l.country ?? ''}</span></TableCell>
                  <TableCell className="text-[12px]">{l.latencyMs != null ? `${l.latencyMs}ms` : '—'}</TableCell>
                  <TableCell className="max-w-xs truncate text-[11px] text-red-400">{l.error ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
