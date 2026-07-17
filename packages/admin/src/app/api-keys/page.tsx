'use client';

import { useState } from 'react';
import { Plus, Trash2, KeyRound, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useApiKeys, useCreateApiKey, useToggleApiKey, useDeleteApiKey } from '@/lib/queries';
import type { ApiKey } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pagination } from '@/components/pagination';
import { formatTs } from '@/lib/utils';

export default function ApiKeysPage() {
  const { data, isLoading } = useApiKeys();
  const keys = data?.data ?? [];
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const paged = keys.slice(page * pageSize, page * pageSize + pageSize);
  return (
    <div className="space-y-6">
      <PageHeader title="API Keys" subtitle="Client keys for calling /v1/* (sha256-hashed)" actions={<CreateButton />} />
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-secondary/40" />)}</div>
      ) : keys.length === 0 ? (
        <EmptyState icon={KeyRound} title="No API keys yet" hint="Create one for clients to authenticate." />
      ) : (
        <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => <KeyRow key={k.id} apiKey={k} />)}
          </TableBody>
        </Table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={keys.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          itemName="keys"
        />
        </>
      )}
    </div>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const toggle = useToggleApiKey();
  const del = useDeleteApiKey();
  return (
    <TableRow>
      <TableCell>{apiKey.name}</TableCell>
      <TableCell className="font-mono text-[12px] text-muted-foreground">{apiKey.keyPrefix}…</TableCell>
      <TableCell className="text-muted-foreground">{formatTs(apiKey.lastUsedAt)}</TableCell>
      <TableCell className="text-muted-foreground">{formatTs(apiKey.createdAt)}</TableCell>
      <TableCell>
        <button onClick={() => toggle.mutate({ id: apiKey.id, enabled: !apiKey.enabled })}>
          <Badge variant={apiKey.enabled ? 'success' : 'muted'}>{apiKey.enabled ? 'enabled' : 'disabled'}</Badge>
        </button>
      </TableCell>
      <TableCell className="text-right">
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="icon">
              <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
            </Button>
          }
          title={`Delete API key "${apiKey.name}"?`}
          description={`This permanently revokes the ${apiKey.keyPrefix}… key. Any client still using it will immediately start receiving 401 Unauthorized.`}
          pending={del.isPending}
          onConfirm={() =>
            del
              .mutateAsync(apiKey.id)
              .then(() => toast.success('API key deleted'))
              .catch((e) => toast.error(e.message))
          }
        />
      </TableCell>
    </TableRow>
  );
}

function CreateButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useCreateApiKey();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await create.mutateAsync(name);
      setCreatedKey(res.plaintext ?? null);
      toast.success('API key created');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const copy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setName(''); setCreatedKey(null); } }}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> Create key</Button></DialogTrigger>
      <DialogContent>
        {createdKey ? (
          <>
            <DialogHeader><DialogTitle>Key created — copy now</DialogTitle></DialogHeader>
            <p className="text-[13px] text-muted-foreground">This plaintext is shown only once. Store it securely.</p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
              <code className="flex-1 break-all font-mono text-[12px]">{createdKey}</code>
              <Button variant="outline" size="icon" onClick={copy}>{copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}</Button>
            </div>
            <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle>Create API key</DialogTitle></DialogHeader>
            <form onSubmit={submit} className="space-y-3" autoComplete="off">
              <div className="space-y-1.5">
                <Label htmlFor="kname">Name</Label>
                <Input id="kname" value={name} onChange={(e) => setName(e.target.value)} placeholder="production" required />
              </div>
              <DialogFooter><Button type="submit" disabled={create.isPending}>Create</Button></DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
