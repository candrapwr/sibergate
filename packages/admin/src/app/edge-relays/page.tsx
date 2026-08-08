'use client';

import { useState } from 'react';
import { Plus, Trash2, Cloud, CheckCircle2, XCircle, Loader2, Zap, RefreshCw, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import {
  useEdgeRelays,
  useCreateEdgeRelay,
  useDeleteEdgeRelay,
  useVerifyEdgeRelay,
  useDeployEdgeRelay,
  useRemoveEdgeRelay,
  useTestEdgeRelay,
} from '@/lib/queries';
import type { EdgeRelay } from '@/lib/types';
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

const RELAY_TYPES = [
  { value: 'cloudflare-workers', label: 'Cloudflare Workers', active: true },
  { value: 'vercel-edge', label: 'Vercel Edge Functions', active: false },
  { value: 'deno-deploy', label: 'Deno Deploy', active: false },
  { value: 'netlify-edge', label: 'Netlify Edge Functions', active: false },
  { value: 'aws-lambda-edge', label: 'AWS Lambda@Edge', active: false },
] as const;

export default function EdgeRelaysPage() {
  const { data, isLoading } = useEdgeRelays();
  const relays = data?.data ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Edge Relays"
        subtitle="Deploy Cloudflare Worker sekali → reuse di pool mana saja. URL-rewrite relay (bukan tunnel)."
        actions={<CreateRelayButton />}
      />
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-border bg-secondary/20" />
      ) : relays.length === 0 ? (
        <EmptyState icon={Cloud} title="Belum ada edge relay" hint="Klik 'New relay' utk deploy CF Worker." />
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

/** Modal deploy/redeploy — input token + accountId + scriptName, verify + deploy. */
function DeployDialog({ relay, open, onOpenChange, children }: {
  relay: EdgeRelay;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  const verify = useVerifyEdgeRelay();
  const deploy = useDeployEdgeRelay();
  const remove = useRemoveEdgeRelay();
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [scriptName, setScriptName] = useState('sibergate-relay');
  const isRedeploy = !!relay.relayUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isRedeploy ? 'Redeploy' : 'Deploy'} — {relay.name}</DialogTitle>
          <DialogDescription>
            Deploy transparent-relay Worker ke Cloudflare. Token disimpan encrypted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="d-token">Cloudflare API Token</Label>
            <Input id="d-token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cf_xxx..." type="password" className="text-[12px]" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-acc">Account ID</Label>
            <Input id="d-acc" value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} placeholder="auto-detected setelah Verify" className="text-[12px] font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-script">Worker Script Name</Label>
            <Input id="d-script" value={scriptName} onChange={(e) => setScriptName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="sibergate-relay" className="text-[12px] font-mono" />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Token butuh permission Account-level "Workers Scripts: Edit" (template "Edit Cloudflare Workers").
          </p>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <div className="flex flex-1 gap-2">
            <Button type="button" variant="outline" size="sm"
              disabled={!token.trim() || verify.isPending}
              onClick={async () => {
                try {
                  const res = await verify.mutateAsync({ id: relay.id, config: { apiToken: token, scriptName, accountId } });
                  if (res.ok && res.accountInfo) {
                    setAccountId((res.accountInfo as { accountId: string }).accountId);
                    toast.success('Token valid (' + (res.accountInfo as { name: string }).name + ')');
                  } else toast.error(res.error ?? 'Verify failed');
                } catch (e) { toast.error((e as Error).message); }
              }}
            >
              {verify.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Verify
            </Button>
            <Button type="button" variant="default" size="sm" className="flex-1"
              disabled={!token.trim() || !accountId.trim() || deploy.isPending}
              onClick={async () => {
                try {
                  const res = await deploy.mutateAsync({ id: relay.id, config: { apiToken: token, accountId, scriptName } });
                  if (res.ok && res.relayUrl) { toast.success('Worker deployed: ' + res.relayUrl); onOpenChange(false); }
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
                  if (res.ok) { toast.success('Worker removed'); onOpenChange(false); }
                  else toast.error(res.error ?? 'Failed');
                } catch (e) { toast.error((e as Error).message); }
              }}
            >
              <Trash2 size={12} /> Remove Worker
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateRelayButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateEdgeRelay();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('cloudflare-workers');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> New relay</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Edge Relay</DialogTitle>
          <DialogDescription>Buat entitas edge relay. Setup token + deploy terpisah di tombol Deploy.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rid">ID</Label>
            <Input id="rid" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="cf-us-relay" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rname">Name</Label>
            <Input id="rname" value={name} onChange={(e) => setName(e.target.value)} placeholder="CF US Relay" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rtype">Type</Label>
            <select id="rtype" value={type} onChange={(e) => setType(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]">
              {RELAY_TYPES.map((t) => (
                <option key={t.value} value={t.value} disabled={!t.active}>
                  {t.label}{!t.active ? ' (coming soon)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!id.trim() || create.isPending} onClick={async () => {
            try { await create.mutateAsync({ id, name: name || id, type }); toast.success('Relay created'); setOpen(false); setId(''); setName(''); }
            catch (e) { toast.error((e as Error).message); }
          }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
