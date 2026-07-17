'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
} from '@/lib/queries';
import type { Provider } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';

export default function ProvidersPage() {
  const { data, isLoading } = useProviders();
  const providers = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        subtitle="Vendor endpoints with encrypted credentials"
        actions={<CreateButton />}
      />
      {isLoading ? (
        <LoadingSkeleton />
      ) : providers.length === 0 ? (
        <EmptyState icon={Boxes} title="No providers yet" hint="Add one to start routing requests." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead>Credentials</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const del = useDeleteProvider();
  return (
    <TableRow>
      <TableCell className="font-mono text-[12px]">{provider.id}</TableCell>
      <TableCell>{provider.name}</TableCell>
      <TableCell className="max-w-xs truncate text-muted-foreground">{provider.baseUrl}</TableCell>
      <TableCell><Badge variant="muted">{provider.authScheme}</Badge></TableCell>
      <TableCell>
        {provider.hasCredentials ? <Badge variant="success">set</Badge> : <Badge variant="warning">missing</Badge>}
      </TableCell>
      <TableCell>
        <Badge variant={provider.enabled ? 'success' : 'muted'}>{provider.enabled ? 'enabled' : 'disabled'}</Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <EditButton provider={provider} />
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              del
                .mutateAsync(provider.id)
                .catch((e) => toast.error(e.status === 409 ? 'Still in use by a model/route' : e.message))
            }
          >
            <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateProvider();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus size={14} /> Add provider</Button>
      </DialogTrigger>
      <DialogContent>
        <ProviderForm
          title="Add Provider"
          submitLabel="Create"
          submitting={create.isPending}
          onSubmit={async (v) => {
            await create.mutateAsync(v);
            toast.success('Provider created');
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditButton({ provider }: { provider: Provider }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateProvider();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon">
          <Pencil size={14} className="text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <ProviderForm
          title="Edit Provider"
          submitLabel="Save"
          provider={provider}
          submitting={update.isPending}
          onSubmit={async (v) => {
            await update.mutateAsync({ id: provider.id, data: v });
            toast.success('Provider updated');
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProviderForm({
  title,
  submitLabel,
  provider,
  submitting,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  provider?: Provider;
  submitting: boolean;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const isEdit = !!provider;
  const [form, setForm] = useState({
    id: provider?.id ?? '',
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? '',
    authScheme: provider?.authScheme ?? 'bearer',
    apiKey: '',
    timeoutMs: provider?.timeoutMs ?? '',
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      id: form.id,
      name: form.name || form.id,
      baseUrl: form.baseUrl,
      authScheme: form.authScheme,
      ...(form.timeoutMs ? { timeoutMs: Number(form.timeoutMs) } : {}),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    };
    try {
      await onSubmit(payload);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        <div className="space-y-1.5">
          <Label htmlFor="pid">ID</Label>
          <Input id="pid" value={form.id} disabled={isEdit} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="openai" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pname">Display name</Label>
          <Input id="pname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="purl">Base URL</Label>
          <Input id="purl" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pauth">Auth scheme</Label>
            <select id="pauth" value={form.authScheme} onChange={(e) => setForm({ ...form, authScheme: e.target.value as 'bearer' | 'x-api-key' })} className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]">
              <option value="bearer">bearer</option>
              <option value="x-api-key">x-api-key</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ptimeout">Timeout (ms)</Label>
            <Input id="ptimeout" type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })} placeholder="30000" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pkey">API key {isEdit && <span className="text-muted-foreground">(blank = keep current)</span>}</Label>
          <Input id="pkey" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." required={!isEdit} />
        </div>
        <DialogFooter><Button type="submit" disabled={submitting}>{submitLabel}</Button></DialogFooter>
      </form>
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-secondary/40" />
      ))}
    </div>
  );
}
