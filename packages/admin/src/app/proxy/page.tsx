'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Trash2, Pencil, Network, Globe, Activity, Zap, CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import {
  useProxyPools,
  useCreateProxyPool,
  useUpdateProxyPool,
  useDeleteProxyPool,
  usePoolMembers,
  useAddPoolMember,
  useDeletePoolMember,
  useTestPoolMember,
  usePoolBindings,
  useBindProvider,
  useUnbindProvider,
  useProviders,
  useVerifyEdgeMember,
  useDeployEdgeMember,
  useRemoveEdgeDeployment,
} from '@/lib/queries';
import type { ProxyPool, ProxyPoolMember, ProxyStrategy } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';

/** ISO country code → emoji flag (regional indicators). */
function flagEmoji(iso: string | null | undefined): string {
  if (!iso || iso.length !== 2) return '🏳️';
  const code = iso.toUpperCase();
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  return String.fromCodePoint(A + (code.charCodeAt(0) - base), A + (code.charCodeAt(1) - base));
}

const STRATEGIES: { value: ProxyStrategy; label: string }[] = [
  { value: 'weighted', label: 'Weighted (random by weight)' },
  { value: 'round-robin', label: 'Round-robin (cycle)' },
  { value: 'failover', label: 'Failover (ordered)' },
];

export default function ProxyPage() {
  const { data, isLoading } = useProxyPools();
  const pools = data?.data ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Proxy Layer"
        subtitle="Outbound proxy pools — rutekan request provider tertentu lewat HTTP/HTTPS/SOCKS5 proxy. Selektif per provider."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/proxy/logs" className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground">
              <ExternalLink size={13} /> Logs
            </Link>
            <CreatePoolButton />
          </div>
        }
      />
      <div className="rounded-lg border border-border bg-secondary/20 p-3 text-[12px] text-muted-foreground">
        <p className="font-medium text-foreground">Cara kerja</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>Buat <b>pool</b> (strategi: weighted/round-robin/failover) + tambahkan <b>member</b> proxy URL.</li>
          <li>Test member utk lihat latensi + IP keluar + 🇺🇸 negara (butuh GeoIP DB di Settings).</li>
          <li><b>Bind</b> provider mana yg request-nya lewat pool ini (selektif — bukan semua provider).</li>
          <li>Health-check otomatis (active ping + passive on-fail). Member unhealthy di-skip.</li>
        </ol>
      </div>
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-border bg-secondary/20" />
      ) : pools.length === 0 ? (
        <EmptyState icon={Network} title="Belum ada proxy pool" hint="Klik 'New pool' untuk membuat pool proxy pertama Anda." />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pool</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead className="w-[120px]">Members</TableHead>
                <TableHead className="w-[120px]">Bound providers</TableHead>
                <TableHead className="w-[90px]">Status</TableHead>
                <TableHead className="w-[140px] text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pools.map((p) => (
                <PoolRow key={p.id} pool={p} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function PoolRow({ pool }: { pool: ProxyPool }) {
  const del = useDeleteProxyPool();
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{pool.name}</div>
        <div className="text-[11px] text-muted-foreground font-mono">{pool.id}</div>
      </TableCell>
      <TableCell className="text-[12px]">{pool.strategy}</TableCell>
      <TableCell>
        <Badge variant={pool.healthyCount > 0 ? 'success' : 'destructive'}>
          {pool.healthyCount}/{pool.memberCount} healthy
        </Badge>
      </TableCell>
      <TableCell className="text-[12px]">{pool.boundProviderCount} provider</TableCell>
      <TableCell>
        {pool.enabled ? <Badge variant="default" className="bg-emerald-600/20 text-emerald-400">on</Badge> : <Badge variant="muted">off</Badge>}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <EditPoolButton pool={pool} />
          <ConfirmDialog
            trigger={<Button variant="ghost" size="icon" title="Delete"><Trash2 size={14} className="text-muted-foreground" /></Button>}
            title={`Delete pool '${pool.id}'?`}
            description="Pool, semua member, dan binding provider akan dihapus."
            pending={del.isPending}
            onConfirm={async () => {
              await del.mutateAsync(pool.id);
              toast.success('Pool deleted');
            }}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreatePoolButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateProxyPool();
  return (
    <PoolFormDialog
      open={open}
      onOpenChange={setOpen}
      title="New Proxy Pool"
      submitLabel="Create"
      submitting={create.isPending}
      onSubmit={async (v) => {
        await create.mutateAsync(v);
        toast.success('Pool created');
        setOpen(false);
      }}
    />
  );
}

function EditPoolButton({ pool }: { pool: ProxyPool }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateProxyPool();
  return (
    <PoolFormDialog
      open={open}
      onOpenChange={setOpen}
      title={`Edit '${pool.id}'`}
      submitLabel="Save"
      pool={pool}
      submitting={update.isPending}
      onSubmit={async (v) => {
        await update.mutateAsync({ id: pool.id, data: { name: v.name, strategy: v.strategy, enabled: v.enabled } });
        toast.success('Pool saved');
        setOpen(false);
      }}
    >
      <MembersSection poolId={pool.id} />
      <BindingsSection poolId={pool.id} />
    </PoolFormDialog>
  );
}

function PoolFormDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  pool,
  submitting,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  submitLabel: string;
  pool?: ProxyPool;
  submitting: boolean;
  onSubmit: (v: { id: string; name?: string; strategy?: ProxyStrategy; enabled?: boolean }) => Promise<void>;
  children?: React.ReactNode;
}) {
  const isEdit = !!pool;
  const [id, setId] = useState(pool?.id ?? '');
  const [name, setName] = useState(pool?.name ?? '');
  const [strategy, setStrategy] = useState<ProxyStrategy>(pool?.strategy ?? 'weighted');
  const [enabled, setEnabled] = useState(pool?.enabled ?? true);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim()) {
      toast.error('ID wajib diisi');
      return;
    }
    try {
      await onSubmit({ id: id.toLowerCase().replace(/[^a-z0-9-_]/g, ''), name: name || id, strategy, enabled });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus size={14} /> {isEdit ? '' : 'New pool'}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pool berisi kumpulan proxy URL. Pilih provider mana yg lewat pool ini di section Bindings (edit mode).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pid">ID</Label>
              <Input id="pid" value={id} disabled={isEdit} onChange={(e) => setId(e.target.value)} placeholder="us-pool" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="US Proxy Pool" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pstrat">Strategy</Label>
              <select
                id="pstrat"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as ProxyStrategy)}
                className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]"
              >
                {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pen">Status</Label>
              <select
                id="pen"
                value={enabled ? 'on' : 'off'}
                onChange={(e) => setEnabled(e.target.value === 'on')}
                className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]"
              >
                <option value="on">Enabled</option>
                <option value="off">Disabled</option>
              </select>
            </div>
          </div>
          {children}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── Members ─────────────────────────── */

const PROXY_TYPES = [
  { value: 'socks5:', label: 'SOCKS5 (default — DNS remote otomatis)' },
  { value: 'socks5h:', label: 'SOCKS5h (explicit DNS remote)' },
  { value: 'http:', label: 'HTTP' },
  { value: 'https:', label: 'HTTPS' },
] as const;

/** Tipe member proxy (http/socks vs edge relay). */
const MEMBER_TYPES = [
  { value: 'http-proxy', label: 'HTTP/SOCKS Proxy' },
  { value: 'edge-relay', label: 'Edge Relay (Cloudflare Workers)' },
] as const;

/** Bangun proxy URL dari field terstruktur. Auth opsional. */
function buildProxyUrl(t: { type: string; host: string; port: string; user: string; pass: string }): string | null {
  const host = t.host.trim();
  const port = t.port.trim();
  if (!host || !port) return null;
  const auth = t.user.trim() ? `${encodeURIComponent(t.user.trim())}:${encodeURIComponent(t.pass)}@` : '';
  return `${t.type}//${auth}${host}:${port}`;
}

function MembersSection({ poolId }: { poolId: string }) {
  const { data } = usePoolMembers(poolId);
  const members = data?.data ?? [];
  const add = useAddPoolMember(poolId);
  const del = useDeletePoolMember(poolId);
  const test = useTestPoolMember(poolId);
  const [memberType, setMemberType] = useState<'http-proxy' | 'edge-relay'>('http-proxy');
  // Form state (terstruktur, bukan URL mentah)
  const [type, setType] = useState<string>('socks5:');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [label, setLabel] = useState('');
  const [weight, setWeight] = useState(1);
  // Edge form state
  const [cfToken, setCfToken] = useState('');
  const [scriptName, setScriptName] = useState('sibergate-relay');

  const canAdd = memberType === 'edge-relay' ? !!cfToken.trim() && !add.isPending : !!(host.trim() && port.trim()) && !add.isPending;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1"><Activity size={13} /> Members</Label>
        <Link href="/proxy/logs" className="flex items-center gap-1 text-[11px] text-primary hover:underline">
          <ExternalLink size={11} /> View logs
        </Link>
      </div>
      <div className="space-y-1.5">
        {members.length === 0 && <p className="text-[11px] italic text-muted-foreground">Belum ada member. Tambahkan proxy/relay di bawah.</p>}
        {members.map((m) => (
          <MemberRow key={m.id} m={m} poolId={poolId} onDelete={() => del.mutate(m.id)} testMut={test} />
        ))}
      </div>
      {/* Add form — pilih tipe member dulu */}
      <div className="space-y-2 rounded border border-border/60 bg-secondary/10 p-2">
        <div className="flex gap-2">
          <select
            value={memberType}
            onChange={(e) => setMemberType(e.target.value as 'http-proxy' | 'edge-relay')}
            className="h-9 rounded-md border border-border bg-background px-2 text-[12px]"
            title="Tipe member"
          >
            {MEMBER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {memberType === 'http-proxy' ? (
          <>
            <div className="flex gap-2">
              <select value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-[12px] font-mono" title="Tipe proxy">
                {PROXY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host (mis. 1.2.3.4 / proxy.com)" className="flex-1 text-[12px]" />
              <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="port" className="w-20 text-[12px]" />
            </div>
            <details className="group">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">Auth (opsional — kosongkan utk no-auth)</summary>
              <div className="mt-1.5 flex gap-2">
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" className="flex-1 text-[12px]" autoComplete="off" />
                <Input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="password" type="password" className="flex-1 text-[12px]" autoComplete="new-password" />
              </div>
            </details>
          </>
        ) : (
          <div className="space-y-1.5 rounded border border-primary/30 bg-primary/5 p-2 text-[11px]">
            <p className="text-muted-foreground">Deploy Cloudflare Worker sbg edge relay (URL rewrite, bukan tunnel). 1 Worker serve semua provider. Token disimpan <b>encrypted</b> di DB.</p>
            <Label htmlFor="cf-token" className="text-[11px]">Cloudflare API Token</Label>
            <Input id="cf-token" value={cfToken} onChange={(e) => setCfToken(e.target.value)} placeholder="cf_xxxxxxxxxxxxxxxx" type="password" className="text-[12px]" autoComplete="off" />
            <Label htmlFor="cf-script" className="text-[11px]">Worker Script Name</Label>
            <Input id="cf-script" value={scriptName} onChange={(e) => setScriptName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="sibergate-relay" className="text-[12px] font-mono" />
            <p className="text-[10px] text-muted-foreground">Setelah add, buka member → klik Verify → Deploy utk aktifkan Worker.</p>
          </div>
        )}
        <div className="flex gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (opsional)" className="flex-1 text-[12px]" />
          <Input type="number" min={1} value={weight} onChange={(e) => setWeight(Number(e.target.value) || 1)} className="w-20 text-[12px]" title="weight" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAdd}
            onClick={async () => {
              try {
                if (memberType === 'edge-relay') {
                  await add.mutateAsync({ type: 'edge-relay', edgeProvider: 'cloudflare-workers', edgeConfig: { apiToken: cfToken, scriptName }, label: label || undefined, weight });
                  setCfToken(''); setScriptName('sibergate-relay'); setLabel(''); setWeight(1);
                } else {
                  const url = buildProxyUrl({ type, host, port, user, pass });
                  if (!url) { toast.error('Host & port wajib diisi'); return; }
                  await add.mutateAsync({ proxyUrl: url, label: label || undefined, weight });
                  setHost(''); setPort(''); setUser(''); setPass(''); setLabel(''); setWeight(1);
                }
                toast.success('Member added');
              } catch (err) {
                toast.error((err as Error).message);
              }
            }}
          >
            <Plus size={13} /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function MemberRow({ m, poolId, onDelete, testMut }: { m: ProxyPoolMember; poolId: string; onDelete: () => void; testMut: ReturnType<typeof useTestPoolMember> }) {
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; exitIp: string | null; geo: { country: string; flag: string } | null; error?: string } | null>(null);
  const [showEdge, setShowEdge] = useState(false);
  const testing = testMut.isPending && testMut.variables === m.id;
  const isEdge = m.type === 'edge-relay';

  const runTest = async () => {
    setResult(null);
    try {
      const r = await testMut.mutateAsync(m.id);
      setResult(r);
    } catch (err) {
      setResult({ ok: false, latencyMs: 0, exitIp: null, geo: null, error: (err as Error).message });
    }
  };

  return (
    <div className="rounded border border-border/60 bg-secondary/20 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none" title={m.country ?? 'unknown'}>
          {isEdge ? (m.relayUrl ? '☁️' : '⏳') : m.healthy ? flagEmoji(m.country) : '❌'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px]">
            {isEdge ? (m.relayUrl ?? '(not deployed)') : redact(m.proxyUrl)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {isEdge ? <span>{m.edgeProvider}{m.relayUrl ? '' : ' · belum deploy'}</span> : <>w:{m.weight}</>}
            {m.label ? ` · ${m.label}` : ''} {m.exitIp && !isEdge ? `· ${m.exitIp}` : ''} {m.country && !isEdge ? `· ${m.country}` : ''}
          </div>
        </div>
        {isEdge && m.relayUrl && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowEdge(!showEdge)} title="Edge deploy panel">
            {showEdge ? 'Hide' : 'Setup'}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" disabled={testing || (isEdge && !m.relayUrl)} onClick={runTest} title="Test connectivity">
          {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Test
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onDelete} title="Delete"><Trash2 size={12} className="text-muted-foreground" /></Button>
      </div>
      {/* Hasil test inline */}
      {testing && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" /> Testing {isEdge ? 'relay' : 'connectivity'}…
        </div>
      )}
      {result && !testing && (
        <div className={`mt-1.5 rounded p-1.5 text-[11px] ${result.ok ? 'bg-emerald-600/10 text-emerald-400' : 'bg-red-600/10 text-red-400'}`}>
          {result.ok ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <CheckCircle2 size={11} /> OK · {result.latencyMs}ms {!isEdge && result.exitIp && <>· exit IP: <span className="font-mono">{result.exitIp}</span></>}
              {!isEdge && result.geo && <span>{result.geo.flag} {result.geo.country}</span>}
            </span>
          ) : (
            <span className="flex items-center gap-1"><XCircle size={11} /> FAILED · {result.error}</span>
          )}
        </div>
      )}
      {/* Edge setup panel (verify/deploy/delete) */}
      {isEdge && showEdge && m.relayUrl && <EdgeMemberPanel m={m} poolId={poolId} />}
      {isEdge && !m.relayUrl && <EdgeSetupNeeded m={m} poolId={poolId} />}
    </div>
  );
}

/** Panel edge relay utk member belum di-deploy — verify + deploy. */
function EdgeSetupNeeded({ m, poolId }: { m: ProxyPoolMember; poolId: string }) {
  const verify = useVerifyEdgeMember(poolId);
  const deploy = useDeployEdgeMember(poolId);
  const [token, setToken] = useState('');
  const [scriptName, setScriptName] = useState('sibergate-relay');
  return (
    <div className="mt-2 space-y-1.5 rounded border border-primary/30 bg-primary/5 p-2 text-[11px]">
      <p className="text-muted-foreground">Worker belum di-deploy. Verify token lalu deploy.</p>
      <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cloudflare API Token" type="password" className="text-[12px]" autoComplete="off" />
      <Input value={scriptName} onChange={(e) => setScriptName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="script name" className="text-[12px] font-mono" />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!token.trim() || verify.isPending}
          onClick={async () => {
            try {
              const r = await verify.mutateAsync({ memberId: m.id, config: { apiToken: token, scriptName } });
              if (r.ok) toast.success('Token valid' + (r.accountInfo ? ` (${r.accountInfo.name})` : ''));
              else toast.error(r.error ?? 'Verify failed');
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          {verify.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Verify
        </Button>
        <Button type="button" variant="default" size="sm" disabled={deploy.isPending}
          onClick={async () => {
            try {
              // Deploy pakai config dari DB (sudah ada accountId setelah verify).
              // Jangan override dgn form config (gak punya accountId).
              const r = await deploy.mutateAsync({ memberId: m.id });
              if (r.ok && r.relayUrl) toast.success('Worker deployed: ' + r.relayUrl);
              else toast.error(r.error ?? 'Deploy failed');
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          {deploy.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Deploy
        </Button>
      </div>
    </div>
  );
}

/** Panel edge relay utk member sudah di-deploy — redeploy / delete deployment. */
function EdgeMemberPanel({ m, poolId }: { m: ProxyPoolMember; poolId: string }) {
  const deploy = useDeployEdgeMember(poolId);
  const remove = useRemoveEdgeDeployment(poolId);
  return (
    <div className="mt-2 space-y-1.5 rounded border border-border/60 bg-secondary/10 p-2 text-[11px]">
      <div className="break-all font-mono text-[10px] text-muted-foreground">URL: {m.relayUrl}</div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={deploy.isPending}
          onClick={async () => {
            try {
              const r = await deploy.mutateAsync({ memberId: m.id });
              r.ok ? toast.success('Redeployed') : toast.error(r.error ?? 'Failed');
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          {deploy.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Redeploy
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={remove.isPending}
          onClick={async () => {
            try {
              const r = await remove.mutateAsync(m.id);
              r.ok ? toast.success('Worker removed') : toast.error(r.error ?? 'Failed');
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          {remove.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove Worker
        </Button>
      </div>
    </div>
  );
}

function redact(url: string): string {
  try {
    const p = new URL(url);
    if (p.username || p.password) return `${p.protocol}//***@${p.host}`;
    return p.href;
  } catch {
    return url;
  }
}

/* ─────────────────────────── Bindings ───────────────────────── */

function BindingsSection({ poolId }: { poolId: string }) {
  const { data: providersData } = useProviders();
  const providers = providersData?.data ?? [];
  const { data: bindingsData } = usePoolBindings(poolId);
  const bindings = bindingsData?.data ?? [];
  const bind = useBindProvider(poolId);
  const unbind = useUnbindProvider(poolId);
  const boundIds = new Set(bindings.filter((b) => b.enabled).map((b) => b.providerId));

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Label className="flex items-center gap-1"><Globe size={13} /> Provider bindings</Label>
      <p className="text-[11px] text-muted-foreground">Centang provider yg request-nya ingin dilewatkan lewat pool ini. Hanya provider terpilih (selektif, bukan semua).</p>
      <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">
        {providers.map((p) => {
          const on = boundIds.has(p.id);
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                if (on) unbind.mutate(p.id);
                else bind.mutate({ providerId: p.id, enabled: true });
              }}
              className={`flex items-center gap-1.5 rounded border px-2 py-1 text-left text-[12px] transition-colors ${
                on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {on ? <CheckCircle2 size={12} className="text-primary" /> : <XCircle size={12} />}
              <span className="truncate">{p.name}</span>
              <span className="ml-auto font-mono text-[10px] opacity-60">{p.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
