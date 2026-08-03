'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Plus, Trash2, Pencil, FileCode2, Play, Boxes, Clock, AlertTriangle, CheckCircle2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  useCustomScripts,
  useCreateCustomScript,
  useUpdateCustomScript,
  useDeleteCustomScript,
  useTestCustomScript,
  useCreateApiKey,
  useCreateProvider,
  useProviders,
  useUpsertModel,
} from '@/lib/queries';
import type { CustomScript, CustomScriptSummary, Provider, ScriptRunResult } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';

// CodeMirror touches document/window at import — load client-only.
const CodeEditor = dynamic(
  () => import('@/components/code-editor').then((m) => m.CodeEditor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

/* ─────────────────────────── Script templates ─────────────────────────── */

const TEMPLATES: Record<string, { label: string; code: string }> = {
  blank: {
    label: 'Blank',
    code: `// Custom Script SiberGate — console.log() output = response body.
// Request body tersedia di stdin (raw string). Metadata di env vars:
//   SIBERGATE_REQUEST_METHOD / _PATH / _QUERY / _HEADERS

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  console.log('Hello from script! body=' + raw);
});
`,
  },
  'chat-json': {
    label: 'Chat (OpenAI JSON)',
    code: `// Format respons OpenAI chat/completions — siap dipakai sebagai target
// route 'chat'. console.log(JSON.stringify(...)) agar output = JSON valid.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const body = raw ? JSON.parse(raw) : {};
  const userMsg = body.messages?.at(-1)?.content ?? '';

  const result = {
    id: 'chat-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'custom',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: \`Halo! Anda bilang: \${userMsg}\` },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  console.log(JSON.stringify(result));
});
`,
  },
  text: {
    label: 'Plain text',
    code: `// Output text biasa (bebas format).
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  console.log('Echo: ' + (raw || '(empty)'));
  console.log('Time: ' + new Date().toISOString());
});
`,
  },
  fetch: {
    label: 'Call external API',
    code: `// Contoh: panggil API eksternal dgn fetch (Node 18+ punya global fetch).
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const res = await fetch('https://api.github.com/zen');
    const text = await res.text();
    console.log(JSON.stringify({ ok: true, zen: text }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }
});
`,
  },
};

function EditorSkeleton() {
  return <div className="h-[360px] animate-pulse rounded-md border border-border bg-secondary/30" />;
}

/* ───────────────────────────── Page shell ─────────────────────────────── */

export default function CustomScriptsPage() {
  const { data, isLoading } = useCustomScripts();
  const scripts = data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Custom Scripts"
        subtitle="Buat endpoint sendiri dari script Node.js. Output console.log = response. Lalu daftarkan sebagai provider."
        actions={<CreateButton />}
      />

      <div className="rounded-lg border border-border bg-secondary/20 p-3 text-[12px] text-muted-foreground">
        <p className="font-medium text-foreground">Cara kerja</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>Tulis script Node.js di sini — output <code className="rounded bg-secondary px-1 font-mono">console.log()</code> jadi response body endpoint.</li>
          <li>Setiap script otomatis tersedia di <code className="rounded bg-secondary px-1 font-mono">{'/api/custom/<id>'}</code> (butuh key client).</li>
          <li>Klik <b>Register as provider</b> agar muncul di Providers → pilih jadi target di Routes. Alur routing tetap utuh.</li>
        </ol>
      </div>

      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-border bg-secondary/20" />
      ) : scripts.length === 0 ? (
        <EmptyState
          icon={FileCode2}
          title="Belum ada custom script"
          hint="Klik 'New script' untuk membuat endpoint pertama Anda."
        />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead className="w-[110px]">Timeout</TableHead>
                <TableHead className="w-[90px]">Status</TableHead>
                <TableHead className="w-[160px] text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scripts.map((s) => (
                <ScriptRow key={s.id} script={s} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────── Row ──────────────────────────────────── */

function ScriptRow({ script }: { script: CustomScriptSummary }) {
  const del = useDeleteCustomScript();
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{script.name}</div>
        {script.description && (
          <div className="text-[11px] text-muted-foreground line-clamp-1">{script.description}</div>
        )}
      </TableCell>
      <TableCell className="font-mono text-[12px] text-muted-foreground">{script.id}</TableCell>
      <TableCell>
        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
          /api/custom/{script.id}
        </code>
      </TableCell>
      <TableCell className="text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock size={11} /> {script.timeoutMs}ms
        </span>
      </TableCell>
      <TableCell>
        {script.enabled ? (
          <Badge className="bg-emerald-600/20 text-emerald-400">enabled</Badge>
        ) : (
          <Badge variant="muted">disabled</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <EditButton script={script} />
          <ConfirmDialog
            trigger={<Button variant="ghost" size="icon" title="Delete"><Trash2 size={14} className="text-muted-foreground" /></Button>}
            title={`Delete '${script.id}'?`}
            description="Script ini akan dihapus permanen. Provider yang memakainya akan gagal saat dipanggil."
            pending={del.isPending}
            onConfirm={async () => {
              await del.mutateAsync(script.id);
              toast.success('Script deleted');
            }}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ────────────────────────────── Buttons ───────────────────────────────── */

function CreateButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateCustomScript();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus size={14} /> New script</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <ScriptForm
          title="New Custom Script"
          submitLabel="Create"
          submitting={create.isPending}
          onSubmit={async (v) => {
            await create.mutateAsync(v as CustomScript);
            toast.success('Script created — endpoint live at /api/custom/' + v.id);
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditButton({ script }: { script: CustomScriptSummary }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateCustomScript();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="Edit / Test / Register"><Pencil size={14} className="text-muted-foreground" /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <ScriptForm
          title={`Edit '${script.id}'`}
          submitLabel="Save"
          script={script}
          submitting={update.isPending}
          onSubmit={async (v) => {
            await update.mutateAsync({ id: script.id, data: v });
            toast.success('Script saved');
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────── Form ──────────────────────────────────── */

function ScriptForm({
  title,
  submitLabel,
  script,
  submitting,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  script?: CustomScriptSummary;
  submitting: boolean;
  onSubmit: (data: Partial<CustomScript> & { id: string }) => Promise<void>;
}) {
  const isEdit = !!script;
  const [form, setForm] = useState({
    id: script?.id ?? '',
    name: script?.name ?? '',
    description: script?.description ?? '',
    timeoutMs: script?.timeoutMs ?? 10000,
    enabled: script?.enabled ?? true,
  });
  // Default to the chat template on create; replaced by the real source on edit.
  const [code, setCode] = useState<string>(TEMPLATES['chat-json'].code);
  const [sourceLoading, setSourceLoading] = useState(isEdit);
  const [testOpen, setTestOpen] = useState(false);
  const [testInput, setTestInput] = useState('{"messages":[{"role":"user","content":"hai"}]}');
  const [testResult, setTestResult] = useState<ScriptRunResult | null>(null);
  const [testing, setTesting] = useState(false);
  const testMut = useTestCustomScript();

  // Lazy-load the full script source when opening an edit dialog. Done here
  // (not in the list query) so we never fetch source for every row.
  useEffect(() => {
    if (!isEdit || !script?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/custom-scripts/${script.id}`).then((r) => r.json());
        if (!cancelled && res && typeof res.script === 'string') setCode(res.script);
      } catch {
        /* leave default template */
      } finally {
        if (!cancelled) setSourceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, script?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.id.trim()) {
      toast.error('ID wajib diisi');
      return;
    }
    try {
      await onSubmit({
        id: form.id,
        name: form.name || form.id,
        description: form.description || undefined,
        timeoutMs: form.timeoutMs,
        enabled: form.enabled,
        script: code,
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const runTest = async () => {
    if (!script?.id) {
      toast.error('Simpan script dulu sebelum test.');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testMut.mutateAsync({ id: script.id, input: testInput });
      setTestResult(res);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Output <code className="font-mono">console.log()</code> script jadi response body endpoint{' '}
          <code className="font-mono">{'/api/custom/<id>'}</code>. Request body = stdin.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="sid">ID (slug)</Label>
            <Input
              id="sid"
              value={form.id}
              disabled={isEdit}
              onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              placeholder="hello-script"
              required
            />
            <p className="text-[10px] text-muted-foreground">Huruf kecil, angka, <code>-</code>. Jadi URL endpoint.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sname">Display name</Label>
            <Input id="sname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Hello Script" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="sto">Timeout (ms)</Label>
            <Input
              id="sto"
              type="number"
              min={500}
              max={300000}
              value={form.timeoutMs}
              onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) || 10000 })}
            />
            <p className="text-[10px] text-muted-foreground">Script di-kill (SIGKILL) setelah ini. 500ms–300000ms.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sdesc">Description</Label>
            <Input id="sdesc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="opsional" />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="scode">Script source (Node.js)</Label>
            <select
              onChange={(e) => {
                const tpl = TEMPLATES[e.target.value];
                if (tpl) setCode(tpl.code);
                e.target.value = '';
              }}
              defaultValue=""
              className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground"
            >
              <option value="" disabled>Insert template…</option>
              {Object.entries(TEMPLATES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          {sourceLoading ? (
            <EditorSkeleton />
          ) : (
            <CodeEditor value={code} onChange={setCode} minHeight={380} />
          )}
        </div>

        <DialogFooter className="items-center">
          {isEdit ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setTestOpen(true)} disabled={sourceLoading}>
              <Play size={13} /> Test
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">Save dulu untuk Test & Register.</span>
          )}
          <div className="flex-1" />
          {isEdit && <RegisterAsProvider scriptId={form.id} scriptName={form.name || form.id} />}
          <Button type="submit" disabled={submitting || sourceLoading}>{submitLabel}</Button>
        </DialogFooter>
      </form>

      {/* Test panel */}
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Test: {form.name || form.id}</DialogTitle>
            <DialogDescription>
              Input di bawah dikirim ke stdin script. Output <code className="font-mono">stdout</code> = response endpoint asli.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tinput">Input (stdin)</Label>
              <textarea
                id="tinput"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                className="min-h-[80px] w-full rounded-md border border-border bg-background p-2 font-mono text-[12px]"
                placeholder='{"messages":[...]} atau text bebas'
              />
            </div>
            <Button type="button" size="sm" onClick={runTest} disabled={testing}>
              <Play size={13} /> {testing ? 'Running…' : 'Run'}
            </Button>
            {testResult && <TestResultPanel result={testResult} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ─────────────────────────── Test result ──────────────────────────────── */

function TestResultPanel({ result }: { result: ScriptRunResult }) {
  const ok = result.ok;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {ok ? (
          <Badge className="bg-emerald-600/20 text-emerald-400"><CheckCircle2 size={11} className="mr-1" /> success</Badge>
        ) : (
          <Badge className="bg-red-600/20 text-red-400"><AlertTriangle size={11} className="mr-1" /> failed</Badge>
        )}
        <span className="text-muted-foreground">exit: <code className="font-mono">{String(result.exitCode)}</code></span>
        <span className="text-muted-foreground">{result.durationMs}ms</span>
        {result.timedOut && <Badge variant="destructive">TIMED OUT</Badge>}
        {result.error && <span className="text-red-400">{result.error}</span>}
      </div>
      <div>
        <Label className="text-[11px] text-muted-foreground">stdout (response body)</Label>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[hsl(220_13%_7%)] p-2 font-mono text-[11px] text-emerald-300">
          {result.stdout || '(empty)'}
        </pre>
      </div>
      {result.stderr && (
        <div>
          <Label className="text-[11px] text-muted-foreground">stderr (tidak dikirim ke client)</Label>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[hsl(220_13%_7%)] p-2 font-mono text-[11px] text-red-300">
            {result.stderr}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────── Register as provider ────────────────────────── */

/** Mapping modality route → model modalities (supaya model muncul di filter route). */
const MODALITY_TO_MODEL_MODALITIES: Record<string, string[]> = {
  generic: ['api'],
  chat: ['text-to-text'],
  image: ['image-generation'],
  speech: ['audio'],
  transcribe: ['audio-transcription'],
  embed: ['embeddings'],
  music: ['audio'],
};

interface RegisterResult {
  providerId: string;
  providerName: string;
  created: boolean; // true = provider baru dibuat; false = reuse provider existing
  modelId: string; // '<providerId>/<scriptId>'
  apiKey?: string; // hanya ada saat provider baru (key loopback pertama)
}

function RegisterAsProvider({ scriptId, scriptName }: { scriptId: string; scriptName: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);
  // Default: provider id = scriptId, nama = "Script: <nama>". Bisa diedit user.
  const [providerId, setProviderId] = useState(scriptId);
  const [providerName, setProviderName] = useState(`Script: ${scriptName}`);
  const [modality, setModality] = useState<string>('generic');
  const { data: providersData } = useProviders();
  const createKey = useCreateApiKey();
  const createProvider = useCreateProvider();
  const upsertModel = useUpsertModel();

  // Deteksi apakah provider id yg diketik sudah ada (untuk reuse). Bila ada,
  // kita tidak akan buat provider/key baru — hanya tambahkan model script ini.
  const existingProvider = providersData?.data.find((p) => p.id === providerId.trim());
  const reusing = !!existingProvider;

  const busy = createKey.isPending || createProvider.isPending || upsertModel.isPending;

  const register = async () => {
    const pid = providerId.trim();
    if (!pid) {
      toast.error('Provider ID wajib diisi.');
      return;
    }
    try {
      let apiKey: string | undefined;
      let providerCreated = false;

      if (!existingProvider) {
        // Provider baru: buat API key loopback + provider dgn endpoint template
        // /api/custom/{model} supaya satu provider bisa serve banyak script.
        const key = await createKey.mutateAsync(`script:${pid}`);
        apiKey = key.plaintext;
        if (!apiKey) {
          toast.error('Gagal membuat API key (plaintext hilang).');
          return;
        }
        await createProvider.mutateAsync({
          id: pid,
          name: providerName.trim() || pid,
          baseUrl: 'http://localhost:8787',
          authScheme: 'bearer',
          apiKey,
          endpoints: { [modality]: '/api/custom/{model}' },
        } as Partial<Provider> & { apiKey?: string });
        providerCreated = true;
      }

      // Selalu buat model utk script ini di bawah provider (baru maupun existing).
      // Model id = '<providerId>/<scriptId>'. Engine strip prefix → upstreamModel
      // = scriptId → endpoint template {model} resolve jadi /api/custom/<scriptId>.
      await upsertModel.mutateAsync({
        id: `${pid}/${scriptId}`,
        provider: pid,
        displayName: scriptName,
        modalities: MODALITY_TO_MODEL_MODALITIES[modality] ?? ['api'],
        capabilities: { custom_script: true },
      } as Partial<import('@/lib/types').Model>);

      setResult({ providerId: pid, providerName: providerName.trim() || pid, created: providerCreated, modelId: `${pid}/${scriptId}`, apiKey });
      toast.success(
        providerCreated
          ? `Provider '${pid}' dibuat + model '${scriptId}' terdaftar.`
          : `Model '${scriptId}' ditambahkan ke provider '${pid}' (reuse).`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const reset = () => {
    setResult(null);
    setProviderId(scriptId);
    setProviderName(`Script: ${scriptName}`);
    setModality('generic');
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Boxes size={13} /> Register as provider
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTimeout(reset, 200); // reset state setelah dialog tutup
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Register script sebagai provider/model</DialogTitle>
            <DialogDescription>
              Script ini akan jadi <b>model</b> di bawah sebuah <b>provider</b>. Satu provider bisa serve banyak script — endpoint templatenya{' '}
              <code className="font-mono">{'/api/custom/{model}'}</code> otomatis resolve ke id script.
            </DialogDescription>
          </DialogHeader>
          {!result ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="rpid">Provider ID</Label>
                <Input
                  id="rpid"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
                  placeholder="my-scripts"
                  className="font-mono text-[12px]"
                />
                <p className="text-[10px] text-muted-foreground">
                  {reusing ? (
                    <span className="text-emerald-400">✓ Provider '{existingProvider?.name}' sudah ada — akan reuse (tidak buat provider/key baru), hanya tambah model.</span>
                  ) : (
                    <>Provider baru akan dibuat dgn endpoint <code className="font-mono">{'/api/custom/{model}'}</code>.</>
                  )}
                </p>
              </div>
              {!reusing && (
                <div className="space-y-1.5">
                  <Label htmlFor="rpname">Provider display name</Label>
                  <Input id="rpname" value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="My Scripts" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="rmod">Modality</Label>
                <select
                  id="rmod"
                  value={modality}
                  onChange={(e) => setModality(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]"
                >
                  <option value="generic">generic (REST bebas — default)</option>
                  <option value="chat">chat (respons format OpenAI)</option>
                  <option value="image">image (generasi gambar)</option>
                  <option value="speech">speech (text-to-speech)</option>
                  <option value="transcribe">transcribe (speech-to-text)</option>
                  <option value="embed">embed (embedding)</option>
                  <option value="music">music (text-to-music)</option>
                </select>
                <p className="text-[10px] text-muted-foreground">
                  Sesuaikan dgn format respons script. Ini jadi endpoint key provider + tag capability model.
                </p>
              </div>
              <div className="rounded-md border border-border bg-secondary/20 p-2 text-[11px] text-muted-foreground">
                Akan dibuat: model <code className="font-mono">{`${providerId || '…'}/${scriptId}`}</code> di provider{' '}
                <code className="font-mono">{providerId || '…'}</code>
                {reusing ? ' (reuse)' : ' (baru)'}. Lalu tambahkan sbg target di Routes dgn modality <b>{modality}</b>.
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                <Button onClick={register} disabled={busy}>
                  {busy ? 'Registering…' : reusing ? 'Add model to provider' : 'Create provider + model'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-emerald-600/30 bg-emerald-600/10 p-3 text-[12px]">
                <p className="font-medium text-emerald-400">✓ {result.created ? 'Provider + model terdaftar' : 'Model ditambahkan ke provider existing'}</p>
                <dl className="mt-2 space-y-1">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd className="font-mono">{result.providerId} ({result.providerName})</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="font-mono">{result.modelId}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Modality</dt>
                    <dd className="font-mono">{modality}</dd>
                  </div>
                </dl>
                {result.apiKey && (
                  <div className="mt-2">
                    <p className="text-muted-foreground">API key loopback (provider baru — simpan bila perlu):</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-secondary px-2 py-1 font-mono text-[11px]">{result.apiKey}</code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          navigator.clipboard.writeText(result.apiKey!);
                          toast.success('Key disalin');
                        }}
                      >
                        <Copy size={13} />
                      </Button>
                    </div>
                  </div>
                )}
                <p className="mt-2 text-muted-foreground">
                  Lanjut: buka <b>Routes</b> → tambah target → pilih provider <b>{result.providerId}</b> + model <b>{result.modelId}</b>.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
