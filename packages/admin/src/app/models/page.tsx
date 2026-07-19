'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Cpu } from 'lucide-react';
import { toast } from 'sonner';
import { useModels, useProviders, useUpsertModel, useDeleteModel, useToggleModel } from '@/lib/queries';
import type { Model } from '@/lib/types';
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

const MODALITIES = ['text-to-text', 'vision', 'image-generation', 'video-generation', 'audio', 'audio-transcription', 'embeddings', 'api'];

export default function ModelsPage() {
  const { data, isLoading } = useModels();
  const { data: providersData } = useProviders();
  const models = data?.data ?? [];

  // id → name lookup so provider filter shows friendly labels.
  const providerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providersData?.data ?? []) m.set(p.id, p.name);
    return m;
  }, [providersData]);

  // Distinct providers & modalities present in the model list (for the filters).
  const presentProviders = useMemo(
    () => [...new Set(models.map((m) => m.provider))].sort(),
    [models],
  );
  const presentModalities = useMemo(
    () => [...new Set(models.flatMap((m) => m.modalities))].sort(),
    [models],
  );

  const [filter, setFilter] = useState({ provider: '', modality: '', q: '', status: '' as '' | 'enabled' | 'disabled' });

  const filtered = useMemo(() => {
    return models.filter((m) => {
      if (filter.provider && m.provider !== filter.provider) return false;
      if (filter.modality && !m.modalities.includes(filter.modality)) return false;
      if (filter.status === 'enabled' && !m.enabled) return false;
      if (filter.status === 'disabled' && m.enabled) return false;
      if (filter.q) {
        const hay = `${m.id} ${m.displayName} ${m.provider} ${m.modalities.join(' ')}`.toLowerCase();
        if (!hay.includes(filter.q.toLowerCase())) return false;
      }
      return true;
    });
  }, [models, filter]);

  const hasFilters = filter.provider || filter.modality || filter.q || filter.status;

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const paged = filtered.slice(page * pageSize, page * pageSize + pageSize);
  // Reset to first page whenever the filter narrows the result set.
  const filteredLen = filtered.length;
  useEffect(() => {
    setPage(0);
  }, [filter.provider, filter.modality, filter.q, filter.status, filteredLen]);

  return (
    <div className="space-y-6">
      <PageHeader title="Models" subtitle="Model directory with JSON modalities" actions={<CreateButton />} />

      {/* Filters */}
      {models.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filter.provider}
            onChange={(e) => setFilter({ ...filter, provider: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-[12px]"
          >
            <option value="">all providers</option>
            {presentProviders.map((p) => (
              <option key={p} value={p}>{providerNames.get(p) ?? p}</option>
            ))}
          </select>
          <select
            value={filter.modality}
            onChange={(e) => setFilter({ ...filter, modality: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-[12px]"
          >
            <option value="">all modalities</option>
            {presentModalities.map((md) => (
              <option key={md} value={md}>{md}</option>
            ))}
          </select>
          <select
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value as '' | 'enabled' | 'disabled' })}
            className="h-9 rounded-md border border-border bg-background px-2 text-[12px]"
          >
            <option value="">all status</option>
            <option value="enabled">enabled only</option>
            <option value="disabled">disabled only</option>
          </select>
          <Input
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            placeholder="Search…"
            className="h-9 w-48 text-[12px]"
          />
          {hasFilters ? (
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} of {models.length}
            </span>
          ) : null}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-secondary/40" />)}</div>
      ) : models.length === 0 ? (
        <EmptyState icon={Cpu} title="No models yet" hint="Register a model against a provider." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Cpu} title="No models match" hint="Adjust the filters above." />
      ) : (
        <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Modalities</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Price (in/out /1M)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((m) => <ModelRow key={m.id} model={m} />)}
          </TableBody>
        </Table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          itemName="models"
        />
        </>
      )}
    </div>
  );
}

function ModelRow({ model }: { model: Model }) {
  const del = useDeleteModel();
  const toggle = useToggleModel();
  return (
    <TableRow>
      <TableCell className="font-mono text-[12px]">{model.id}</TableCell>
      <TableCell><Badge variant="muted">{model.provider}</Badge></TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {model.modalities.map((md) => <Badge key={md} variant="outline">{md}</Badge>)}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}k` : '—'}</TableCell>
      <TableCell className="text-muted-foreground">
        {model.inputPricePer1m != null ? `$${model.inputPricePer1m}/${model.outputPricePer1m ?? '-'}` : '—'}
      </TableCell>
      <TableCell>
        <button onClick={() => toggle.mutate({ id: model.id, enabled: !model.enabled })} title={model.enabled ? 'Click to disable' : 'Click to enable'}>
          <Badge variant={model.enabled ? 'success' : 'muted'}>{model.enabled ? 'enabled' : 'disabled'}</Badge>
        </button>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <EditButton model={model} />
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon">
                <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
              </Button>
            }
            title={`Delete model "${model.id}"?`}
            description="This permanently removes the model from the directory. Routes that target it will keep the reference but the target will no longer resolve."
            pending={del.isPending}
            onConfirm={() =>
              del
                .mutateAsync(model.id)
                .then(() => toast.success('Model deleted'))
                .catch((e) => toast.error(e.status === 409 ? 'Used by a route' : e.message))
            }
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> Add model</Button></DialogTrigger>
      <DialogContent><ModelForm title="Add Model" submitLabel="Create" onSubmit={() => setOpen(false)} /></DialogContent>
    </Dialog>
  );
}

function EditButton({ model }: { model: Model }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="icon"><Pencil size={14} className="text-muted-foreground" /></Button></DialogTrigger>
      <DialogContent><ModelForm title="Edit Model" submitLabel="Save" model={model} onSubmit={() => setOpen(false)} /></DialogContent>
    </Dialog>
  );
}

function ModelForm({ title, submitLabel, model, onSubmit }: { title: string; submitLabel: string; model?: Model; onSubmit: () => void }) {
  const { data: providers } = useProviders();
  const upsert = useUpsertModel();
  const isEdit = !!model;
  const [form, setForm] = useState({
    id: model?.id ?? '',
    provider: model?.provider ?? '',
    displayName: model?.displayName ?? '',
    modalities: model?.modalities ?? ['text-to-text'],
    contextWindow: model?.contextWindow ?? '',
    inputPricePer1m: model?.inputPricePer1m ?? '',
    outputPricePer1m: model?.outputPricePer1m ?? '',
  });

  const toggleModality = (m: string) =>
    setForm((f) => ({ ...f, modalities: f.modalities.includes(m) ? f.modalities.filter((x) => x !== m) : [...f.modalities, m] }));

  // Saat Add Model: begitu user pilih provider, otomatis prefik field ID dgn
  // '{provider}/' (konvensi namespaced) supaya id tetap globally unik dan URL
  // admin /admin/models/{id} tidak ambigu antar provider. Hanya ganti prefix
  // provider lama (jika ada) — biarkan user bebas mengedit sisinya.
  const onProviderChange = (providerId: string) => {
    setForm((f) => {
      if (isEdit) return { ...f, provider: providerId };
      const slashIdx = f.id.indexOf('/');
      const tail = slashIdx >= 0 ? f.id.slice(slashIdx + 1) : f.id;
      return { ...f, provider: providerId, id: providerId ? `${providerId}/${tail}` : tail };
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      id: form.id,
      provider: form.provider,
      displayName: form.displayName || form.id,
      modalities: form.modalities,
      ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
      ...(form.inputPricePer1m ? { inputPricePer1m: Number(form.inputPricePer1m) } : {}),
      ...(form.outputPricePer1m ? { outputPricePer1m: Number(form.outputPricePer1m) } : {}),
      ...((isEdit ? { __edit: true } : {})),
    };
    try {
      await upsert.mutateAsync(payload as any);
      toast.success(isEdit ? 'Model updated' : 'Model created');
      onSubmit();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mid">ID</Label>
            <Input id="mid" value={form.id} disabled={isEdit} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="openai/gpt-4o-mini" required />
            {!isEdit && (
              <p className="text-[11px] text-muted-foreground">
                Otomatis berprefik <code>{form.provider ? `${form.provider}/` : '{provider}/'}</code> agar unik antar provider. Bisa diedit.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mprovider">Provider</Label>
            <select id="mprovider" value={form.provider} onChange={(e) => onProviderChange(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]" required>
              <option value="">Select…</option>
              {providers?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mname">Display name</Label>
          <Input id="mname" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="GPT-4o mini" />
        </div>
        <div className="space-y-1.5">
          <Label>Modalities</Label>
          <div className="flex flex-wrap gap-1.5">
            {MODALITIES.map((m) => (
              <button type="button" key={m} onClick={() => toggleModality(m)} className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${form.modalities.includes(m) ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mctx">Context</Label>
            <Input id="mctx" type="number" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} placeholder="128000" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="min">In $/1M</Label>
            <Input id="min" type="number" step="0.01" value={form.inputPricePer1m} onChange={(e) => setForm({ ...form, inputPricePer1m: e.target.value })} placeholder="0.15" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mout">Out $/1M</Label>
            <Input id="mout" type="number" step="0.01" value={form.outputPricePer1m} onChange={(e) => setForm({ ...form, outputPricePer1m: e.target.value })} placeholder="0.60" />
          </div>
        </div>
        <DialogFooter><Button type="submit" disabled={upsert.isPending}>{submitLabel}</Button></DialogFooter>
      </form>
    </>
  );
}
