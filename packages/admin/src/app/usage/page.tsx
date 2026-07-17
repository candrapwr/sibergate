'use client';

import { useMemo, useState } from 'react';
import { BarChart3, Boxes, Cpu, Route as RouteIcon } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useStats, useUsageMatrix } from '@/lib/queries';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { formatMs, formatNum, formatUsd } from '@/lib/utils';

const ACCENT = '#4daafc';
const GREEN = '#6abf6e';
const YELLOW = '#d9b14a';
const RED = '#e07070';

type Dim = 'route' | 'provider' | 'model';

const DIM_META: Record<Dim, { label: string; icon: typeof Boxes; color: string }> = {
  route: { label: 'Route', icon: RouteIcon, color: ACCENT },
  provider: { label: 'Provider', icon: Boxes, color: GREEN },
  model: { label: 'Model', icon: Cpu, color: YELLOW },
};

export default function UsagePage() {
  const { data: stats, isLoading } = useStats();
  const { data: matrixData } = useUsageMatrix();
  const matrix = matrixData?.data ?? [];
  const [dim, setDim] = useState<Dim>('provider');

  const rows = useMemo(() => {
    const list = dim === 'route' ? stats?.byRoute : dim === 'provider' ? stats?.byProvider : stats?.byModel;
    return (list ?? []).slice().sort((a, b) => b.totalTokens - a.totalTokens);
  }, [dim, stats]);

  const chartData = rows.map((r) => ({ name: r.name, tokens: r.totalTokens, cost: r.costUsd }));

  // Totals for summary cards.
  const totalIn = rows.reduce((s, r) => s + r.promptTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.completionTokens, 0);
  const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Usage" subtitle="Token consumption & cost monitoring" />

      {/* Dimension selector */}
      <div className="flex gap-2">
        {(Object.keys(DIM_META) as Dim[]).map((d) => {
          const meta = DIM_META[d];
          const Icon = meta.icon;
          const active = dim === d;
          return (
            <button
              key={d}
              onClick={() => setDim(d)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
                active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              <Icon size={14} /> {meta.label}
            </button>
          );
        })}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard label="Prompt tokens" value={formatNum(totalIn)} color={ACCENT} />
        <SummaryCard label="Completion tokens" value={formatNum(totalOut)} color={GREEN} />
        <SummaryCard label="Total tokens" value={formatNum(totalTokens)} color={YELLOW} />
        <SummaryCard label="Total cost" value={formatUsd(totalCost)} color={RED} />
      </div>

      {/* Token consumption chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 size={14} /> Token Consumption by {DIM_META[dim].label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No usage data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 6% 20%)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(220 5% 54%)' }} stroke="hsl(220 6% 20%)" />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(220 5% 54%)' }} stroke="hsl(220 6% 20%)" tickFormatter={(v) => formatNum(v)} />
                <Tooltip
                  cursor={{ fill: 'hsl(220 6% 16%)' }}
                  contentStyle={{ background: 'hsl(222 11% 12%)', border: '1px solid hsl(220 6% 20%)', borderRadius: 6, fontSize: 12 }}
                  formatter={(v) => formatNum(v as number)}
                />
                <Bar dataKey="tokens" radius={[3, 3, 0, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={DIM_META[dim].color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Detailed table by dimension */}
      <Card>
        <CardHeader>
          <CardTitle>Breakdown by {DIM_META[dim].label}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-md bg-secondary/40" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState icon={DIM_META[dim].icon} title="No usage data yet" hint="Send requests to see token consumption." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{DIM_META[dim].label}</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Prompt</TableHead>
                  <TableHead className="text-right">Completion</TableHead>
                  <TableHead className="text-right">Total tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="font-mono text-[12px]">{r.name}</TableCell>
                    <TableCell className="text-right">{formatNum(r.count)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatNum(r.promptTokens)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatNum(r.completionTokens)}</TableCell>
                    <TableCell className="text-right font-medium">{formatNum(r.totalTokens)}</TableCell>
                    <TableCell className="text-right">{formatUsd(r.costUsd)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatMs(r.avgLatencyMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Provider × Model matrix */}
      <Card>
        <CardHeader>
          <CardTitle>Provider × Model consumption</CardTitle>
        </CardHeader>
        <CardContent>
          {matrix.length === 0 ? (
            <EmptyState icon={Cpu} title="No per-model data yet" hint="Successful requests populate this matrix." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Total tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.map((m, i) => (
                  <TableRow key={`${m.provider}:${m.model}:${i}`}>
                    <TableCell><Badge variant="outline" className="font-mono">{m.provider}</Badge></TableCell>
                    <TableCell className="font-mono text-[12px]">{m.model}</TableCell>
                    <TableCell className="text-right">{formatNum(m.count)}</TableCell>
                    <TableCell className="text-right font-medium">{formatNum(m.totalTokens)}</TableCell>
                    <TableCell className="text-right">{formatUsd(m.costUsd)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatMs(m.avgLatencyMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold" style={{ color }}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
