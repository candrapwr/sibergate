'use client';

import { useState, useMemo } from 'react';
import { Plus, Trash2, Cloud, CheckCircle2, XCircle, Loader2, Zap, RefreshCw, Rocket, Info, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import {
  useEdgeRelays,
  useCreateEdgeRelay,
  useDeleteEdgeRelay,
  useVerifyEdgeRelay,
  useDeployEdgeRelay,
  useRemoveEdgeRelay,
  useTestEdgeRelay,
  useEdgeProviders,
} from '@/lib/queries';
import type { EdgeRelay, EdgeProviderInfo, ConfigField } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';

/** AWS Lambda@Edge belum ada di registry backend (arsitektur berbeda). UI hanya
 * menampilkan provider yg ada di backend. Saat backend di-extend dgn AWS nanti,
 * otomatis muncul di sini tanpa ubah frontend. */

/** Badge utk status provider edge. */
function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge className="bg-emerald-600/20 text-emerald-400">active</Badge>;
  if (status === 'beta') return <Badge variant="warning">beta</Badge>;
  return <Badge variant="muted">coming soon</Badge>;
}

export default function EdgeRelaysPage() {
  const { data, isLoading } = useEdgeRelays();
  const relays = data?.data ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Edge Relays"
        subtitle="Deploy edge relay sekali → reuse di pool mana saja. URL-rewrite relay (bukan tunnel SOCKS)."
        actions={<CreateRelayButton />}
      />
      <div className="rounded-lg border border-border bg-secondary/20 p-3 text-[12px] text-muted-foreground">
        <p className="flex items-center gap-1 font-medium text-foreground">
          <Info size={13} /> Bagaimana edge relay bekerja
        </p>
        <ul className="mt-1.5 space-y-1 pl-1">
          <li>
            <b className="text-foreground">1 relay melayani SEMUA provider & modality</b> — Worker/edge function
            transparent membaca header <code className="rounded bg-secondary px-1 font-mono">x-relay-target</code> dan
            meneruskan request ke provider mana pun (chat, image, embed, music, dll). Tidak perlu deploy per-provider.
          </li>
          <li>
            <b className="text-foreground">URL-rewrite, bukan tunnel</b> — request di-rewrite ke URL relay (Worker/edge)
            lalu di-forward ke provider asli. Berbeda dari proxy HTTP/SOCKS (tunnel level transport).
          </li>
          <li>
            <b className="text-foreground">Deploy sekali, reuse di pool mana saja</b> — buat relay → deploy → pilih di
            pool member. Bisa dipakai banyak pool sekaligus.
          </li>
          <li>
            <b className="text-foreground">4 provider didukung</b> — Cloudflare Workers, Vercel Edge, Deno Deploy,
            Netlify Edge. AWS Lambda@Edge coming soon. Token disimpan <b>encrypted</b>, tidak pernah di-log.
          </li>
        </ul>
      </div>
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-border bg-secondary/20" />
      ) : relays.length === 0 ? (
        <EmptyState icon={Cloud} title="Belum ada edge relay" hint="Klik 'New relay' utk deploy edge function." />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-[280px] text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {relays.map((r) => <RelayRow key={r.id} r={r} />)}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RelayRow({ r }: { r: EdgeRelay }) {
  const del = useDeleteEdgeRelay();
  const test = useTestEdgeRelay();
  const [deployOpen, setDeployOpen] = useState(false);

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{r.name}</div>
        <div className="text-[11px] text-muted-foreground font-mono">{r.id}</div>
      </TableCell>
      <TableCell><Badge variant="default">{r.type}</Badge></TableCell>
      <TableCell>
        {r.relayUrl ? (
          r.healthy ? <Badge className="bg-emerald-600/20 text-emerald-400">deployed</Badge>
                    : <Badge variant="warning">unhealthy</Badge>
        ) : <Badge variant="muted">pending</Badge>}
      </TableCell>
      <TableCell className="max-w-xs">
        {r.relayUrl ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">{r.relayUrl}</span>
        ) : <span className="text-[11px] italic text-muted-foreground">belum deploy</span>}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {!r.relayUrl && (
            <DeployDialog relay={r} open={deployOpen} onOpenChange={setDeployOpen}>
              <Button type="button" variant="default" size="sm">
                <Rocket size={12} /> Deploy
              </Button>
            </DeployDialog>
          )}
          {r.relayUrl && (
            <>
              <Button type="button" variant="ghost" size="sm"
                disabled={test.isPending}
                onClick={async () => {
                  try {
                    const res = await test.mutateAsync(r.id);
                    res.ok ? toast.success(`OK ${res.latencyMs}ms`) : toast.error(res.error ?? 'Test failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              ><Zap size={12} /> Test</Button>
              <DeployDialog relay={r} open={deployOpen} onOpenChange={setDeployOpen}>
                <Button type="button" variant="ghost" size="sm"><RefreshCw size={12} /> Redeploy</Button>
              </DeployDialog>
            </>
          )}
          <ConfirmDialog
            trigger={<Button variant="ghost" size="icon" title="Delete"><Trash2 size={13} className="text-destructive" /></Button>}
            title={`Delete '${r.id}'?`}
            description="Edge relay entity + deployment akan dihapus."
            pending={del.isPending}
            onConfirm={async () => { await del.mutateAsync(r.id); toast.success('Relay deleted'); }}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Render field config tunggal (text/password) dari metadata provider. */
function ConfigFieldInput({ field, value, onChange, optional }: { field: ConfigField; value: string; onChange: (v: string) => void; optional?: boolean }) {
  // optional = field wajib tapi boleh kosong krn pakai config tersimpan (redeploy).
  const showRequired = field.required && !optional;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`cf-${field.key}`} className="text-[12px]">
        {field.label}{showRequired ? ' *' : ''}
        {optional && <span className="ml-1 text-[10px] text-muted-foreground">(tersimpan)</span>}
      </Label>
      <Input
        id={`cf-${field.key}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        type={field.type === 'password' ? 'password' : 'text'}
        className="text-[12px]"
        autoComplete="off"
      />
      {field.helper && <p className="text-[10px] text-muted-foreground leading-snug">{field.helper}</p>}
    </div>
  );
}

/** Modal deploy/redeploy — form dinamis berdasarkan configFields provider terpilih. */
function DeployDialog({ relay, open, onOpenChange, children }: {
  relay: EdgeRelay;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  const verify = useVerifyEdgeRelay();
  const deploy = useDeployEdgeRelay();
  const remove = useRemoveEdgeRelay();
  const { data: providersData } = useEdgeProviders();
  const providers = providersData?.data ?? [];
  const provider = providers.find((p) => p.id === relay.type);
  const fields = provider?.configFields ?? [];
  // State values per field key. Reset ketika provider ganti (key set berubah).
  const [values, setValues] = useState<Record<string, string>>({});
  const isRedeploy = !!relay.relayUrl;
  // Redeploy dgn config tersimpan (hasConfig) → field wajib boleh kosong (pakai
  // nilai tersimpan di DB). Deploy baru (belum ada config) → field wajib harus diisi.
  const hasStoredConfig = relay.hasConfig;

  const setValue = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  // Build config: hanya sertakan field yg diisi user (skip empty). Backend merge
  // dgn config DB (token tersimpan), jadi empty field = pakai nilai lama.
  const config = useMemo(() => {
    const c: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.key]?.trim();
      if (v) c[f.key] = v;
    }
    return c;
  }, [fields, values]);

  // Required check: bila ada config tersimpan, field wajib boleh kosong. Bila
  // deploy baru (belum ada config), field wajib harus diisi.
  const requiredMissing = !hasStoredConfig && fields.some((f) => f.required && !(values[f.key]?.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md">
        {/* autoComplete="off" + data-* utk suppress autofill/password manager
            (token, project name, dll bukan form login). Form-level paling
            efektif di Safari/Chrome (per-input "off" sering diabaikan). */}
        <form autoComplete="off" data-lpignore="true" onSubmit={(e) => e.preventDefault()} className="space-y-4">
        <DialogHeader>
          <DialogTitle>{isRedeploy ? 'Redeploy' : 'Deploy'} — {relay.name}</DialogTitle>
          <DialogDescription>
            Deploy transparent-relay ke {provider?.displayName ?? relay.type}. Token disimpan encrypted.
            {hasStoredConfig && ' Kosongkan field utk pakai nilai tersimpan (cukup klik Deploy langsung).'}
          </DialogDescription>
        </DialogHeader>
        {provider && (
          <div className="rounded-md border border-border/60 bg-secondary/10 p-2 text-[11px] text-muted-foreground">
            <p className="leading-snug">{provider.description}</p>
            {provider.docsUrl && (
              <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary hover:underline">
                <ExternalLink size={10} /> Docs {provider.displayName}
              </a>
            )}
          </div>
        )}
        <div className="space-y-3">
          {fields.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">
              Provider ini belum punya field config (coming soon).
            </p>
          ) : (
            fields.map((f) => (
              <ConfigFieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} optional={hasStoredConfig} />
            ))
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <div className="flex flex-1 gap-2">
            <Button type="button" variant="outline" size="sm"
              disabled={requiredMissing || verify.isPending}
              onClick={async () => {
                try {
                  const res = await verify.mutateAsync({ id: relay.id, config });
                  if (res.ok && res.accountInfo) {
                    // Isi field accountId bila provider punya (mis. CF, Vercel).
                    if ('accountId' in res.accountInfo && res.accountInfo.accountId) {
                      setValue('accountId', res.accountInfo.accountId);
                    }
                    toast.success('Token valid (' + res.accountInfo.name + ')');
                  } else toast.error(res.error ?? 'Verify failed');
                } catch (e) { toast.error((e as Error).message); }
              }}
            >
              {verify.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Verify
            </Button>
            <Button type="button" variant="default" size="sm" className="flex-1"
              disabled={requiredMissing || deploy.isPending}
              onClick={async () => {
                try {
                  const res = await deploy.mutateAsync({ id: relay.id, config });
                  if (res.ok && res.relayUrl) { toast.success('Deployed: ' + res.relayUrl); onOpenChange(false); }
                  else toast.error(res.error ?? 'Deploy failed');
                } catch (e) { toast.error((e as Error).message); }
              }}
            >
              {deploy.isPending ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
              {isRedeploy ? 'Redeploy' : 'Deploy'}
            </Button>
          </div>
          {isRedeploy && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  const res = await remove.mutateAsync(relay.id);
                  if (res.ok) { toast.success('Deployment removed'); onOpenChange(false); }
                  else toast.error(res.error ?? 'Failed');
                } catch (e) { toast.error((e as Error).message); }
              }}
            >
              <Trash2 size={12} /> Remove
            </Button>
          )}
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateRelayButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateEdgeRelay();
  const { data: providersData } = useEdgeProviders();
  const providers = providersData?.data ?? [];
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('cloudflare-workers');
  const selected = providers.find((p) => p.id === type);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> New relay</Button></DialogTrigger>
      <DialogContent>
        <form autoComplete="off" data-lpignore="true" onSubmit={(e) => e.preventDefault()} className="space-y-4">
        <DialogHeader>
          <DialogTitle>New Edge Relay</DialogTitle>
          <DialogDescription>Buat entitas edge relay. Setup token + deploy terpisah di tombol Deploy.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rid">ID</Label>
            <Input id="rid" name="sg-relay-id" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="cf-us-relay" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rname">Name</Label>
            <Input id="rname" name="sg-relay-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CF US Relay" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rtype">Type</Label>
            <select id="rtype" value={type} onChange={(e) => setType(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]">
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={p.status === 'coming-soon'}>
                  {p.displayName}{p.status === 'coming-soon' ? ' (coming soon)' : ''}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <div className="rounded-md border border-border/60 bg-secondary/10 p-2 text-[11px] text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5">
                <StatusBadge status={selected.status} />
                {selected.docsUrl && (
                  <a href={selected.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                    <ExternalLink size={10} /> docs
                  </a>
                )}
              </div>
              <p className="leading-snug">{selected.description}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button disabled={!id.trim() || create.isPending} onClick={async () => {
            try { await create.mutateAsync({ id, name: name || id, type }); toast.success('Relay created'); setOpen(false); setId(''); setName(''); }
            catch (e) { toast.error((e as Error).message); }
          }}>Create</Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
