'use client';

import { useState } from 'react';
import { Plus, Trash2, Cloud, CheckCircle2, XCircle, Loader2, Zap, RefreshCw } from 'lucide-react';
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
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';

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
                <TableHead className="w-[200px] text-right">Aksi</TableHead>
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
  const verify = useVerifyEdgeRelay();
  const deploy = useDeployEdgeRelay();
  const remove = useRemoveEdgeRelay();
  const test = useTestEdgeRelay();
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [scriptName, setScriptName] = useState('sibergate-relay');

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
        <div className="flex flex-col gap-1">
          {!r.relayUrl && (
            <div className="flex gap-1">
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="CF token" type="password" className="h-7 text-[11px]" autoComplete="off" />
              <Input value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} placeholder="account id" className="h-7 w-24 text-[11px] font-mono" />
            </div>
          )}
          {!r.relayUrl && (
            <div className="flex gap-1">
              <Input value={scriptName} onChange={(e) => setScriptName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="script" className="h-7 text-[11px] font-mono" />
              <Button type="button" variant="outline" size="sm" className="h-7 px-2"
                disabled={!token.trim() || verify.isPending}
                onClick={async () => {
                  try {
                    const res = await verify.mutateAsync({ id: r.id, config: { apiToken: token, scriptName, accountId } });
                    if (res.ok && res.accountInfo) {
                      setAccountId((res.accountInfo as { accountId: string }).accountId);
                      toast.success('Token valid');
                    } else toast.error(res.error ?? 'Verify failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              >Verify</Button>
              <Button type="button" variant="default" size="sm" className="h-7 px-2"
                disabled={!token.trim() || !accountId.trim() || deploy.isPending}
                onClick={async () => {
                  try {
                    const res = await deploy.mutateAsync({ id: r.id, config: { apiToken: token, accountId, scriptName } });
                    if (res.ok && res.relayUrl) toast.success('Deployed: ' + res.relayUrl);
                    else toast.error(res.error ?? 'Deploy failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              >Deploy</Button>
            </div>
          )}
          {r.relayUrl && (
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="sm" className="h-7"
                disabled={test.isPending}
                onClick={async () => {
                  try {
                    const res = await test.mutateAsync(r.id);
                    if (res.ok) toast.success(`OK ${res.latencyMs}ms`);
                    else toast.error(res.error ?? 'Test failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              ><Zap size={11} /> Test</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7"
                disabled={deploy.isPending}
                onClick={async () => {
                  try {
                    const res = await deploy.mutateAsync({ id: r.id });
                    res.ok ? toast.success('Redeployed') : toast.error(res.error ?? 'Failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              ><RefreshCw size={11} /> Redeploy</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7"
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    const res = await remove.mutateAsync(r.id);
                    res.ok ? toast.success('Worker removed') : toast.error(res.error ?? 'Failed');
                  } catch (e) { toast.error((e as Error).message); }
                }}
              >Remove</Button>
            </div>
          )}
          <ConfirmDialog
            trigger={<Button variant="ghost" size="sm" className="h-7 w-full text-destructive"><Trash2 size={11} /> Delete relay</Button>}
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

function CreateRelayButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateEdgeRelay();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> New relay</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New Edge Relay</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rid">ID</Label>
            <Input id="rid" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="cf-us-relay" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rname">Name</Label>
            <Input id="rname" value={name} onChange={(e) => setName(e.target.value)} placeholder="CF US Relay" />
          </div>
          <p className="text-[11px] text-muted-foreground">Setelah create, isi token + verify + deploy di row relay.</p>
        </div>
        <DialogFooter>
          <Button disabled={!id.trim() || create.isPending} onClick={async () => {
            try { await create.mutateAsync({ id, name: name || id }); toast.success('Relay created'); setOpen(false); setId(''); setName(''); }
            catch (e) { toast.error((e as Error).message); }
          }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
