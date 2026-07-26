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
  useProviderKeys,
  useCreateProviderKey,
  useUpdateProviderKey,
  useDeleteProviderKey,
  useSetDefaultProviderKey,
} from '@/lib/queries';
import type { Provider, ProviderKey } from '@/lib/types';
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
        {provider.keyCount > 0 && <Badge variant="muted" className="ml-1">+{provider.keyCount} key{provider.keyCount !== 1 ? 's' : ''}</Badge>}
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
      // API key tidak lagi di-set di sini — key dikelola via section "API keys"
      // di bawah (provider_keys), termasuk key default. Create provider tanpa
      // key dulu lalu tambah key setelahnya.
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

        {/* Multi API keys — tambahan key upstream per provider (multi-account).
            Hanya tampil saat EDIT (provider sudah ada). Key utama tetap kolom
            API key di atas (provider.credentials default); section ini utk key
            tambahan yg bisa di-assign ke route target (target.keyId). */}
        {isEdit && provider && <ProviderKeysSection providerId={provider.id} />}

        <DialogFooter><Button type="submit" disabled={submitting}>{submitLabel}</Button></DialogFooter>
      </form>
    </>
  );
}

/**
 * Section daftar key tambahan milik sebuah provider (multi-account). Tampilkan
 * label + prefix redacted + toggle enable + hapus. Form tambah key baru di
 * bawahnya. Plaintext value gak pernah keluar API — hanya label + prefix.
 */
function ProviderKeysSection({ providerId }: { providerId: string }) {
  const { data, isLoading } = useProviderKeys(providerId);
  const createKey = useCreateProviderKey();
  const updateKey = useUpdateProviderKey();
  const deleteKey = useDeleteProviderKey();
  const setDefault = useSetDefaultProviderKey();
  const [newKey, setNewKey] = useState({ label: '', apiKey: '' });
  const keys = (data?.data ?? []) as ProviderKey[];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.label.trim() || !newKey.apiKey.trim()) return;
    try {
      await createKey.mutateAsync({
        providerId,
        label: newKey.label.trim(),
        apiKey: newKey.apiKey.trim(),
      });
      setNewKey({ label: '', apiKey: '' });
      toast.success('Key added.');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2.5">
      <div className="flex items-center justify-between">
        <Label>API keys</Label>
        <span className="text-[10px] text-muted-foreground">
          {keys.length} key{keys.length !== 1 ? 's' : ''} · multi-account
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Satu key ditandai <span className="font-medium text-foreground">default</span> — dipakai saat route target tidak
        menunjuk key spesifik. Key lain bisa di-assign ke target tertentu di halaman Routes (mis. utk load-balance antar akun).
      </p>

      {isLoading ? (
        <div className="h-8 animate-pulse rounded bg-secondary/40" />
      ) : keys.length === 0 ? (
        <p className="py-1 text-[11px] italic text-muted-foreground">
          No keys yet. Add one below — key pertama otomatis jadi default.
        </p>
      ) : (
        <div className="space-y-1">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded border border-border/40 bg-background px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium">{k.label}</span>
                  {k.isDefault && (
                    <Badge variant="success" className="shrink-0 px-1 py-0 text-[9px]">default</Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{k.keyPrefix}</div>
              </div>
              <button
                type="button"
                onClick={() =>
                  updateKey.mutate({ providerId, keyId: k.id, data: { enabled: !k.enabled } })
                }
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  k.enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
                title={k.enabled ? 'Disable' : 'Enable'}
              >
                {k.enabled ? 'on' : 'off'}
              </button>
              {!k.isDefault && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await setDefault.mutateAsync({ providerId, keyId: k.id });
                      toast.success('Default key set.');
                    } catch (err) {
                      toast.error((err as Error).message);
                    }
                  }}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20"
                  title="Jadikan key default provider ini"
                >
                  set default
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Delete key "${k.label}"? Targets using it fall back to default key.`)) return;
                  try {
                    await deleteKey.mutateAsync({ providerId, keyId: k.id });
                    toast.success('Key deleted.');
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
                className="text-muted-foreground hover:text-destructive"
                title="Delete key"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tambah key baru. Bukan <form> krn sudah berada di dalam form dialog
          provider (HTML melarang nested form → hydration error). Pakai button
          onClick + handle Enter via onKeyDown utk UX submit. */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Input
          value={newKey.label}
          onChange={(e) => setNewKey({ ...newKey, label: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(e as unknown as React.FormEvent); } }}
          placeholder="Label (e.g. Akun Kantor)"
          className="h-8 w-40 text-[12px]"
        />
        <Input
          value={newKey.apiKey}
          onChange={(e) => setNewKey({ ...newKey, apiKey: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(e as unknown as React.FormEvent); } }}
          placeholder="API key value"
          type="password"
          className="h-8 flex-1 text-[12px]"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={createKey.isPending || !newKey.label.trim() || !newKey.apiKey.trim()}
          onClick={add as unknown as React.MouseEventHandler}
        >
          <Plus size={13} /> Add
        </Button>
      </div>
    </div>
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
