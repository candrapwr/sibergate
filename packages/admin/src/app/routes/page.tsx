'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Route as RouteIcon, X, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { useRoutes, useProviders, useModels, useUpsertRoute, useDeleteRoute, useToggleRoute } from '@/lib/queries';
import type { Route } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { RouteTestDialog } from '@/components/routes/route-test-dialog';
import { RouteCodeDialog } from '@/components/routes/route-code-dialog';

const STRATEGIES = [
  { id: 'fallback', label: 'Fallback', desc: 'Try targets in order; on failure go to next.' },
  { id: 'fastest', label: 'Fastest', desc: 'Auto-pick lowest-latency target.' },
  { id: 'weighted', label: 'Weighted', desc: 'Distribute by weight to dodge rate limits.' },
] as const;

const MODALITIES = [
  { id: 'chat', label: 'Chat', desc: 'Text conversation (/v1/chat/completions)' },
  { id: 'image', label: 'Image', desc: 'Image generation (/v1/images/generations)' },
  { id: 'speech', label: 'Speech', desc: 'Text-to-speech (/v1/audio/speech)' },
  { id: 'transcribe', label: 'Transcribe', desc: 'Audio→text (/v1/audio/transcriptions)' },
  { id: 'embed', label: 'Embed', desc: 'Embeddings (/v1/embeddings)' },
  { id: 'music', label: 'Music', desc: 'Text-to-music (/v1/music/generations)' },
] as const;

export default function RoutesPage() {
  const { data, isLoading } = useRoutes();
  const routes = data?.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title="Routes" subtitle="Virtual endpoints clients call — resolved by strategy" actions={<CreateButton />} />
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-secondary/40" />)}</div>
      ) : routes.length === 0 ? (
        <EmptyState icon={RouteIcon} title="No routes yet" hint="Create a route to expose a virtual model." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route ID <span className="ml-1 text-[10px] normal-case text-muted-foreground">(clients call as model)</span></TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead>Targets <span className="ml-1 text-[10px] normal-case text-muted-foreground">(provider:model)</span></TableHead>
              <TableHead>Timeout</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((r) => <RouteRow key={r.id} route={r} />)}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function RouteRow({ route }: { route: Route }) {
  const del = useDeleteRoute();
  const toggle = useToggleRoute();
  return (
    <TableRow>
      <TableCell className="font-mono text-[12px]">{route.id}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Badge variant={route.modality === 'chat' ? 'muted' : 'default'}>{route.modality ?? 'chat'}</Badge>
          <Badge variant="outline">{route.strategy}</Badge>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {route.targets.map((t, i) => (
            <span key={i} className="flex items-center gap-1">
              <Badge variant="outline" className="font-mono">{t.provider}:{t.model}</Badge>
              {i < route.targets.length - 1 && <ArrowRight size={11} className="text-muted-foreground" />}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{(route.timeoutMs / 1000).toFixed(0)}s</TableCell>
      <TableCell>
        <button onClick={() => toggle.mutate({ id: route.id, enabled: !route.enabled })} title={route.enabled ? 'Click to disable' : 'Click to enable'}>
          <Badge variant={route.enabled ? 'success' : 'muted'}>{route.enabled ? 'enabled' : 'disabled'}</Badge>
        </button>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <RouteCodeDialog route={route} />
          <RouteTestDialog route={route} />
          <EditButton route={route} />
          <Button variant="ghost" size="icon" onClick={() => del.mutateAsync(route.id).catch((e) => toast.error(e.message))}>
            <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> Add route</Button></DialogTrigger>
      <DialogContent className="max-w-2xl"><RouteForm title="Add Route" submitLabel="Create" onSubmit={() => setOpen(false)} /></DialogContent>
    </Dialog>
  );
}

function EditButton({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="icon"><Pencil size={14} className="text-muted-foreground" /></Button></DialogTrigger>
      <DialogContent className="max-w-2xl"><RouteForm title="Edit Route" submitLabel="Save" route={route} onSubmit={() => setOpen(false)} /></DialogContent>
    </Dialog>
  );
}

interface TargetInput { provider: string; model: string; priority: number; weight: number }

function RouteForm({ title, submitLabel, route, onSubmit }: { title: string; submitLabel: string; route?: Route; onSubmit: () => void }) {
  const { data: providers } = useProviders();
  const { data: models } = useModels();
  const upsert = useUpsertRoute();
  const isEdit = !!route;
  const [form, setForm] = useState({
    id: route?.id ?? '',
    name: route?.name ?? '',
    modality: route?.modality ?? 'chat',
    strategy: route?.strategy ?? 'fallback',
    timeoutMs: route?.timeoutMs ?? 30000,
    targets: (route?.targets ?? []).map((t) => ({ provider: t.provider, model: t.model, priority: t.priority, weight: t.weight })) as TargetInput[],
  });
  const [newTarget, setNewTarget] = useState({ provider: '', model: '' });

  // Only providers that support the selected modality can be picked as targets.
  const capableProviders = providers?.data.filter((p) => p.modalities.includes(form.modality)) ?? [];

  const addTarget = () => {
    if (!newTarget.provider || !newTarget.model) return;
    setForm({ ...form, targets: [...form.targets, { ...newTarget, priority: form.targets.length, weight: 1 }] });
    setNewTarget({ provider: '', model: '' });
  };
  const removeTarget = (i: number) => setForm({ ...form, targets: form.targets.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, priority: idx })) });
  const updateTarget = (i: number, patch: Partial<TargetInput>) =>
    setForm({ ...form, targets: form.targets.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      id: form.id,
      name: form.name || form.id,
      modality: form.modality,
      strategy: form.strategy,
      timeoutMs: Number(form.timeoutMs),
      targets: form.targets.map((t) => ({ provider: t.provider, model: t.model, priority: t.priority, weight: Number(t.weight) })),
      ...(isEdit ? { __edit: true } : {}),
    };
    try {
      await upsert.mutateAsync(payload as any);
      toast.success(isEdit ? 'Route updated' : 'Route created');
      onSubmit();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Map a route modality to the model-capability values that mean "this model
  // can serve that modality". e.g. route modality "image" ↔ model capability
  // "image-generation"; "speech"/"music" ↔ "audio"; "transcribe" ↔ "audio-
  // transcription". Chat matches any text model.
  const ROUTE_TO_MODEL_MODALITY: Record<string, string[]> = {
    chat: ['text-to-text', 'vision'],
    image: ['image-generation'],
    speech: ['audio'],
    transcribe: ['audio-transcription'],
    embed: ['embeddings'],
    music: ['audio'],
  };
  const neededCaps = ROUTE_TO_MODEL_MODALITY[form.modality] ?? [];

  const availableModels =
    models?.data.filter((m) => {
      if (newTarget.provider && m.provider !== newTarget.provider) return false;
      // Only models whose capabilities include one of the values for this modality.
      if (neededCaps.length === 0) return true;
      return m.modalities.some((cap) => neededCaps.includes(cap));
    }) ?? [];

  return (
    <>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rid">ID</Label>
            <Input id="rid" value={form.id} disabled={isEdit} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="smart" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rname">Name</Label>
            <Input id="rname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Smart" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Modality</Label>
          <select
            value={form.modality}
            onChange={(e) => { setForm({ ...form, modality: e.target.value as typeof form.modality, targets: [] }); setNewTarget({ provider: '', model: '' }); }}
            className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]"
          >
            {MODALITIES.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Strategy</Label>
          <div className="grid grid-cols-3 gap-2">
            {STRATEGIES.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => setForm({ ...form, strategy: s.id })}
                className={`rounded-md border p-2 text-left transition-colors ${form.strategy === s.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary'}`}
              >
                <div className="text-[12px] font-medium">{s.label}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{s.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rtimeout">Timeout (ms)</Label>
          <Input id="rtimeout" type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label>Targets {form.strategy === 'fallback' && '(ordered)'}</Label>
          <div className="space-y-1.5">
            {form.targets.map((t, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
                <span className="text-[11px] text-muted-foreground">#{i}</span>
                <span className="flex-1 font-mono text-[12px]">{t.provider}:{t.model}</span>
                <Input type="number" value={t.weight} onChange={(e) => updateTarget(i, { weight: Number(e.target.value) })} className="h-7 w-16 px-2 text-[12px]" placeholder="w" />
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeTarget(i)}><X size={12} /></Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <select value={newTarget.provider} onChange={(e) => setNewTarget({ provider: e.target.value, model: '' })} className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-[12px]">
                <option value="">provider…</option>
                {capableProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={newTarget.model} onChange={(e) => setNewTarget({ ...newTarget, model: e.target.value })} className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-[12px]">
                <option value="">model…</option>
                {availableModels.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={addTarget}><Plus size={14} /></Button>
            </div>
          </div>
        </div>
        <DialogFooter><Button type="submit" disabled={upsert.isPending || form.targets.length === 0}>{submitLabel}</Button></DialogFooter>
      </form>
    </>
  );
}
