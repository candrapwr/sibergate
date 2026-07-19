'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useToggleProvider,
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pagination } from '@/components/pagination';
import { StatusFilter } from '@/components/status-filter';

export default function ProvidersPage() {
  const { data, isLoading } = useProviders();
  const allProviders = data?.data ?? [];
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const providers = statusFilter === 'all'
    ? allProviders
    : allProviders.filter((p) => (statusFilter === 'enabled' ? p.enabled : !p.enabled));
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const paged = providers.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        subtitle="Vendor endpoints with encrypted credentials"
        actions={<CreateButton />}
      />
      {isLoading ? (
        <LoadingSkeleton />
      ) : allProviders.length === 0 ? (
        <EmptyState icon={Boxes} title="No providers yet" hint="Add one to start routing requests." />
      ) : (
        <>
        <StatusFilter value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(0); }} />
        {providers.length === 0 ? (
          <EmptyState icon={Boxes} title="No providers match" hint={`No ${statusFilter} providers. Switch the filter.`} />
        ) : (
        <>
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
            {paged.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={providers.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          itemName="providers"
        />
        </>
        )}
        </>
      )}
    </div>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const del = useDeleteProvider();
  const toggle = useToggleProvider();
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
        <button
          onClick={() => toggle.mutate({ id: provider.id, enabled: !provider.enabled })}
          title={provider.enabled ? 'Click to disable' : 'Click to enable'}
        >
          <Badge variant={provider.enabled ? 'success' : 'muted'}>{provider.enabled ? 'enabled' : 'disabled'}</Badge>
        </button>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <EditButton provider={provider} />
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon">
                <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
              </Button>
            }
            title={`Delete provider "${provider.id}"?`}
            description="This permanently removes the provider and its encrypted credentials. Models that reference it will also be deleted. Routes may lose targets."
            pending={del.isPending}
            onConfirm={() =>
              del
                .mutateAsync(provider.id)
                .then(() => toast.success('Provider deleted'))
                .catch((e) => toast.error(e.status === 409 ? 'Still in use by a model/route' : e.message))
            }
          />
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
  });
  // Per-modality endpoint templates (e.g. {generic:"/anything/{path}"}).
  // Initialized from the provider's existing endpoints map on edit.
  const [endpoints, setEndpoints] = useState<Array<{ key: string; value: string }>>(
    provider ? Object.entries(provider.endpoints).map(([key, value]) => ({ key, value })) : [],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const endpointMap: Record<string, string> = {};
    for (const { key, value } of endpoints) {
      const k = key.trim();
      if (k) endpointMap[k] = value;
    }
    const payload: Record<string, unknown> = {
      id: form.id,
      name: form.name || form.id,
      baseUrl: form.baseUrl,
      authScheme: form.authScheme,
      // Only send endpoints when the operator added custom templates; otherwise
      // the provider inherits the OpenAI-compatible defaults at the catalog/
      // config layer (empty {} would wipe them).
      ...(Object.keys(endpointMap).length > 0 ? { endpoints: endpointMap } : {}),
      // 'none' auth needs no key; on create the gateway requires a key, so send
      // a harmless placeholder. On edit, blank keeps the existing credentials.
      ...(form.authScheme === 'none' && !isEdit ? { apiKey: 'none' } : {}),
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
          <Input
            id="pid"
            value={form.id}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, id: e.target.value.replace(/[\s/]+/g, '') })}
            placeholder="openai"
            required
          />
          <p className="text-[10px] text-muted-foreground">Huruf, angka, <code>-</code>, atau <code>_</code>. Slash/spasi otomatis dihapus.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pname">Display name</Label>
          <Input id="pname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="purl">Base URL</Label>
          <Input id="purl" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pauth">Auth scheme</Label>
          <select
            id="pauth"
            value={form.authScheme}
            onChange={(e) => setForm({ ...form, authScheme: e.target.value as Provider['authScheme'] })}
            className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]"
          >
            <option value="bearer">bearer</option>
            <option value="x-api-key">x-api-key</option>
            <option value="query">query (?api_key=)</option>
            <option value="basic">basic (HTTP Basic)</option>
            <option value="none">none (public)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pkey">
            API key{' '}
            {isEdit ? <span className="text-muted-foreground">(blank = keep current)</span> : null}
            {form.authScheme === 'none' && <span className="text-muted-foreground">(not required for none)</span>}
          </Label>
          <Input
            id="pkey"
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="sk-..."
            required={isEdit ? false : form.authScheme !== 'none'}
          />
        </div>

        {/* Per-modality endpoint templates.
            Most providers inherit the OpenAI-compatible defaults automatically,
            so this is empty for them. It matters for `generic` (the passthrough
            modality) where you MUST set the upstream path, optionally with
            {model} / {path} placeholders. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="pendpoints">Endpoint templates</Label>
            <button
              type="button"
              onClick={() => setEndpoints([...endpoints, { key: '', value: '' }])}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <Plus size={11} /> Add
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Optional. Override the upstream path per modality. For <code className="font-mono">generic</code> routes, set e.g.{' '}
            <code className="rounded bg-secondary px-1 font-mono">{'{ "generic": "/anything{path}" }'}</code>. Placeholders:{' '}
            <code className="font-mono">{'{path}'}</code> (request suffix), <code className="font-mono">{'{model}'}</code>.
          </p>
          <div className="space-y-2">
            {endpoints.length === 0 && (
              <p className="text-[11px] italic text-muted-foreground">No custom endpoints — provider inherits OpenAI-compatible defaults.</p>
            )}
            {endpoints.map((ep, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={ep.key}
                  onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  placeholder="generic"
                  className="font-mono text-[12px]"
                />
                <Input
                  value={ep.value}
                  onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  placeholder="/anything{path}"
                  className="font-mono text-[12px]"
                />
                <button
                  type="button"
                  onClick={() => setEndpoints(endpoints.filter((_, j) => j !== i))}
                  className="px-2 text-muted-foreground hover:text-destructive"
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
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
