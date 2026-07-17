'use client';

import { useState } from 'react';
import { Settings as SettingsIcon, Download, AlertTriangle, Trash2, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { useImportProviders, useResetAll, useSystem } from '@/lib/queries';
import { KNOWN_STATS } from '@/lib/known-providers-client';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

export default function SettingsPage() {
  const { data: system } = useSystem();

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Bulk operations & data management" />

      {/* Import known providers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download size={15} /> Import known providers
          </CardTitle>
          <CardDescription>
            Seed {KNOWN_STATS.providers} providers and {KNOWN_STATS.models} models from the built-in
            catalog (OpenAI, DeepSeek, Anthropic, Gemini, Groq, …) with empty credentials. Existing
            entries are kept — you then set each provider's API key on the Providers page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImportButton />
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle size={15} /> Danger zone
          </CardTitle>
          <CardDescription>
            Permanently delete ALL data: providers, models, routes, API keys, and request logs. The
            encryption master key and database schema are preserved. This cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-[12px] text-muted-foreground">
            <div>Current data: {system?.providers ?? 0} providers · {system?.models ?? 0} models · {system?.routes ?? 0} routes · {system?.apiKeys ?? 0} keys</div>
          </div>
          <div className="mt-3">
            <ResetButton />
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon size={15} /> About
          </CardTitle>
        </CardHeader>
        <CardContent className="text-[12px] text-muted-foreground">
          SiberGate Gateway · config version {system?.configVersion ?? 0}
        </CardContent>
      </Card>
    </div>
  );
}

function ImportButton() {
  const imp = useImportProviders();
  const [done, setDone] = useState<{ providersImported: number; modelsImported: number; providersSkipped: number; modelsSkipped: number } | null>(null);

  const run = async () => {
    try {
      const r = await imp.mutateAsync();
      setDone({
        providersImported: r.providersImported,
        modelsImported: r.modelsImported,
        providersSkipped: r.providersSkipped,
        modelsSkipped: r.modelsSkipped,
      });
      toast.success(`Imported ${r.providersImported} providers, ${r.modelsImported} models`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <Button onClick={run} disabled={imp.isPending}>
        <Boxes size={14} /> {imp.isPending ? 'Importing…' : 'Import catalog'}
      </Button>
      {done && (
        <div className="rounded-md border border-border bg-background p-3 text-[12px]">
          <div className="font-medium text-success">Import complete</div>
          <div className="mt-1 text-muted-foreground">
            +{done.providersImported} providers (+{done.modelsImported} models)
            {done.providersSkipped + done.modelsSkipped > 0 && (
              <> · {done.providersSkipped} providers / {done.modelsSkipped} models already existed (kept)</>
            )}
          </div>
          <div className="mt-2">
            Next: go to <strong>Providers</strong> and set each provider's API key.
          </div>
        </div>
      )}
    </div>
  );
}

function ResetButton() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const reset = useResetAll();

  const run = async () => {
    if (confirmText !== 'DELETE') return;
    try {
      const r = await reset.mutateAsync();
      toast.success(`Cleared all data (${r.removed.providers + r.removed.models + r.removed.routes + r.removed.logs} rows)`);
      setOpen(false);
      setConfirmText('');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirmText(''); }}>
      <DialogTrigger asChild>
        <Button variant="destructive">
          <Trash2 size={14} /> Clear all data
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle size={15} /> Confirm destructive action
          </DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">
          This permanently deletes all providers, models, routes, API keys, and request logs.
          The encryption key and schema are kept. Type <strong className="text-foreground">DELETE</strong> to confirm.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Type DELETE</Label>
          <Input
            id="confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            className="text-[12px]"
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={run} disabled={confirmText !== 'DELETE' || reset.isPending}>
            {reset.isPending ? 'Clearing…' : 'Yes, delete everything'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
