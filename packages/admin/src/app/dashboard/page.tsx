'use client';

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  Gauge,
  Hash,
} from 'lucide-react';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/page-header';
import { useStats } from '@/lib/queries';
import { formatMs, formatNum, formatPct, formatUsd } from '@/lib/utils';

const ACCENT = '#4daafc';
const GREEN = '#6abf6e';
const YELLOW = '#d9b14a';
const RED = '#e07070';

export default function DashboardPage() {
  const { data: stats, isLoading } = useStats();

  const successRate =
    stats && stats.totalRequests > 0 ? (stats.successCount / stats.totalRequests) * 100 : null;

  const cards = [
    {
      label: 'Total Requests',
      value: formatNum(stats?.totalRequests),
      icon: Hash,
      color: ACCENT,
    },
    {
      label: 'Success Rate',
      value: formatPct(successRate),
      icon: CheckCircle2,
      color: GREEN,
    },
    {
      label: 'Errors',
      value: formatNum(stats?.errorCount),
      icon: AlertTriangle,
      color: RED,
    },
    {
      label: 'Total Tokens',
      value: formatNum(stats?.totalTokens),
      icon: Activity,
      color: YELLOW,
    },
    {
      label: 'Total Spend',
      value: formatUsd(stats?.totalCostUsd),
      icon: Coins,
      color: GREEN,
    },
  ];

  const routeData = (stats?.byRoute ?? []).map((r) => ({
    name: r.name,
    requests: r.count,
    tokens: r.totalTokens,
    cost: r.costUsd,
    latency: r.avgLatencyMs,
  }));
  const providerData = (stats?.byProvider ?? []).map((p) => ({
    name: p.name,
    requests: p.count,
    tokens: p.totalTokens,
    cost: p.costUsd,
    latency: p.avgLatencyMs,
  }));
  const modelData = (stats?.byModel ?? []).map((m) => ({
    name: m.name,
    tokens: m.totalTokens,
    cost: m.costUsd,
    requests: m.count,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Gateway overview — auto-refreshes every 10s" />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-muted-foreground">{c.label}</CardTitle>
                <Icon size={15} style={{ color: c.color }} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {isLoading ? <span className="text-muted-foreground">—</span> : c.value}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Hash size={14} /> Requests by Route
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={routeData} xKey="name" bars={[{ key: 'requests', color: ACCENT }]} empty={routeData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge size={14} /> Requests by Provider
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={providerData} xKey="name" bars={[{ key: 'requests', color: GREEN }]} empty={providerData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge size={14} /> Avg Latency by Route (ms)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={routeData} xKey="name" bars={[{ key: 'latency', color: YELLOW }]} fmt={(v) => formatMs(v as number)} empty={routeData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge size={14} /> Avg Latency by Provider (ms)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={providerData} xKey="name" bars={[{ key: 'latency', color: RED }]} fmt={(v) => formatMs(v as number)} empty={providerData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity size={14} /> Token Consumption by Provider
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={providerData} xKey="name" bars={[{ key: 'tokens', color: ACCENT }]} fmt={(v) => formatNum(v as number)} empty={providerData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity size={14} /> Token Consumption by Model
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={modelData} xKey="name" bars={[{ key: 'tokens', color: GREEN }]} fmt={(v) => formatNum(v as number)} empty={modelData.length === 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins size={14} /> Cost by Route (USD)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Chart data={routeData} xKey="name" bars={[{ key: 'cost', color: YELLOW }]} fmt={(v) => formatUsd(v as number)} empty={routeData.length === 0} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Chart({
  data,
  xKey,
  bars,
  fmt,
  empty,
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  bars: Array<{ key: string; color: string }>;
  fmt?: (v: unknown) => string;
  empty?: boolean;
}) {
  if (empty) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={192}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 6% 20%)" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: 'hsl(220 5% 54%)' }} stroke="hsl(220 6% 20%)" />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(220 5% 54%)' }} stroke="hsl(220 6% 20%)" tickFormatter={(v) => (fmt ? fmt(v) : String(v))} />
        <Tooltip
          cursor={{ fill: 'hsl(220 6% 16%)' }}
          contentStyle={{
            background: 'hsl(222 11% 12%)',
            border: '1px solid hsl(220 6% 20%)',
            borderRadius: 6,
            fontSize: 12,
          }}
          formatter={(v) => (fmt ? fmt(v) : formatNum(v as number))}
        />
        {bars.map((b) => (
          <Bar key={b.key} dataKey={b.key} radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={b.color} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
