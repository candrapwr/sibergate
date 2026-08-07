'use client';

import { useState, useRef } from 'react';
import { Settings as SettingsIcon, Download, AlertTriangle, Trash2, Boxes, Upload, DatabaseBackup, Loader2, Eraser, BarChart3, KeyRound, Globe } from 'lucide-react';
import { toast } from 'sonner';
import { useImportProviders, useResetAll, useClearLogs, useResetStats, useSystem, useSignatures, useClearSignatures, useGeoIpStatus, useUpdateGeoIp } from '@/lib/queries';
import { api } from '@/lib/api-client';
import { KNOWN_STATS } from '@/lib/known-providers-client';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';

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

      {/* Backup & Restore */}
      <BackupRestoreSection />

      {/* Maintenance: clear logs / reset stats (light-weight destructive) */}
      <MaintenanceSection />

      {/* GeoIP database (untuk Proxy Layer flag detection) */}
      <GeoIpSection />

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

function MaintenanceSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eraser size={15} /> Maintenance
        </CardTitle>
        <CardDescription>
          Bersihkan log request dan reset statistik (latency EMA + usage). Master data (providers, models,
          routes, API keys) tidak tersentuh.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ClearLogsButton />
        <ResetStatsButton />
        <ClearSignaturesButton />
      </CardContent>
    </Card>
  );
}

/**
 * Signature cache (Gemini thought_signature utk multi-turn tool calling).
 * Tampilkan jumlah entry cached + tombol clear manual. Entry auto-expire 1 jam.
 */
function ClearSignaturesButton() {
  const { data } = useSignatures();
  const clear = useClearSignatures();
  const count = data?.count ?? 0;
  const run = async () => {
    const r = await clear.mutateAsync();
    toast.success(`Cleared ${r.removed.cleared} signature(s)`);
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          <KeyRound size={13} /> Signature cache
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            {count} cached
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Gemini <code className="font-mono">thought_signature</code> utk multi-turn tool calling. Auto-expire 1 jam.
          Clear bila ingin paksa re-init (mis. setelah debug).
        </div>
      </div>
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm" disabled={count === 0}>
            <Trash2 size={14} /> Clear
          </Button>
        }
        title="Clear signature cache?"
        description={`${count} signature akan dihapus. Conversation multi-turn Gemini aktif perlu re-init. Master data & request log aman.`}
        confirmLabel="Clear signatures"
        pending={clear.isPending}
        onConfirm={run}
      />
    </div>
  );
}

function ClearLogsButton() {
  const clear = useClearLogs();
  const run = async () => {
    const r = await clear.mutateAsync();
    toast.success(`Cleared ${r.removed.logs} request log(s)`);
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium">Clear request logs</div>
        <div className="text-[11px] text-muted-foreground">
          Hapus semua baris di tabel requests. Usage/stats jadi kosong karena dihitung dari log ini.
        </div>
      </div>
      <ConfirmDialog
        trigger={<Button variant="outline" size="sm"><Trash2 size={14} /> Clear logs</Button>}
        title="Clear request logs?"
        description="Semua histori request (latency, token, cost, error) akan dihapus permanen. Master data aman. Tidak bisa di-undo."
        confirmLabel="Clear logs"
        pending={clear.isPending}
        onConfirm={run}
      />
    </div>
  );
}

function ResetStatsButton() {
  const reset = useResetStats();
  const run = async () => {
    const r = await reset.mutateAsync();
    toast.success(`Reset stats: ${r.removed.logs} logs cleared, ${r.removed.latencyEntries} latency entries reset`);
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium">Reset statistics</div>
        <div className="text-[11px] text-muted-foreground">
          Clear logs + reset tracker latency in-memory (EMA). Berguna setelah ganti provider/migrasi besar
          supaya strategi &lsquo;fastest&rsquo; tidak pakai data lama.
        </div>
      </div>
      <ConfirmDialog
        trigger={<Button variant="outline" size="sm"><BarChart3 size={14} /> Reset stats</Button>}
        title="Reset statistics?"
        description="Semua request log dihapus DAN latency tracker direset ke kosong. Strategi 'fastest' akan belajar ulang dari nol. Master data aman."
        confirmLabel="Reset stats"
        pending={reset.isPending}
        onConfirm={run}
      />
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

/* ─────────────────────────── Backup & Restore ─────────────────────────── */

function BackupRestoreSection() {
  const [restoring, setRestoring] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [showRestore, setShowRestore] = useState(false);
  const [backupData, setBackupData] = useState<{ db: string; masterKey: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleBackup = () => {
    // Trigger download via a direct fetch (bypasses api-client JSON parsing).
    window.open('/api/admin/backup', '_blank');
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.db || !parsed.masterKey) throw new Error('Invalid backup file');
      setBackupData({ db: parsed.db, masterKey: parsed.masterKey });
      setShowRestore(true);
      toast.success('Backup file loaded. Confirm to restore.');
    } catch (err) {
      toast.error(`Invalid backup file: ${(err as Error).message}`);
    }
  };

  const doRestore = async () => {
    if (confirmText !== 'RESTORE' || !backupData) return;
    setRestoring(true);
    try {
      await api.post('restore', backupData);
      toast.success('Restore complete — restart the gateway to apply.');
      setShowRestore(false);
      setConfirmText('');
      setBackupData(null);
      // Reload page after short delay.
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup size={15} /> Backup & Restore
        </CardTitle>
        <CardDescription>
          Download a full backup (database + encryption key) to migrate SiberGate
          to another server. The backup file contains everything — providers,
          models, routes, keys, and encrypted credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleBackup}>
            <Download size={14} /> Download backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.sibergate-backup,application/json"
            className="hidden"
            onChange={handleFile}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Upload backup
          </Button>
        </div>

        {showRestore && backupData && (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-warning">
              <AlertTriangle size={14} /> Confirm restore
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              This will <strong>replace all current data</strong> with the backup. Type{' '}
              <strong className="text-foreground">RESTORE</strong> to confirm.
            </p>
            <div className="mt-2 flex gap-2">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="RESTORE"
                className="text-[12px]"
                autoComplete="off"
              />
              <Button
                variant="destructive"
                disabled={confirmText !== 'RESTORE' || restoring}
                onClick={doRestore}
              >
                {restoring ? <Loader2 size={14} className="animate-spin" /> : null}
                {restoring ? 'Restoring…' : 'Restore'}
              </Button>
              <Button variant="outline" onClick={() => { setShowRestore(false); setConfirmText(''); setBackupData(null); }}>
                Cancel
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              ⚠️ After restore, restart the gateway (<code className="font-mono">npm run dev</code>) for changes to take effect.
            </p>
          </div>
        )}

        <div className="text-[11px] text-muted-foreground">
          <p>📦 Backup includes: SQLite database, encryption master key, all providers/models/routes/keys/users.</p>
          <p className="mt-1">🔒 Keep the backup file safe — it contains your encrypted API keys and the key to decrypt them.</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** GeoIP database section — download/update MaxMind GeoLite2 utk proxy flag detection. */
const DEFAULT_GEOIP_URL = 'https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-Country.mmdb';

function GeoIpSection() {
  const { data: status } = useGeoIpStatus();
  const update = useUpdateGeoIp();
  const [url, setUrl] = useState(DEFAULT_GEOIP_URL);
  const sizeMb = status?.sizeBytes ? (status.sizeBytes / 1024 / 1024).toFixed(1) : null;
  const doDownload = () =>
    update
      .mutateAsync(url.trim() || DEFAULT_GEOIP_URL)
      .then((r) => (r.ok ? toast.success('GeoIP DB updated') : toast.error(r.error ?? 'Update failed')))
      .catch((e) => toast.error((e as Error).message));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe size={15} /> GeoIP Database
        </CardTitle>
        <CardDescription>
          MaxMind GeoLite2 dipakai Proxy Layer utk deteksi negara + flag proxy (🇺🇸). File di-download on-demand
          & TIDAK ikut backup DB (bisa re-download). Default: mirror P3TERX (re-publish MaxMind official,
          <b> tanpa registrasi / license key</b>). Ganti URL bila mau pakai mirror lain atau DB City/ASN.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center gap-2">
            <Badge variant={status?.present ? 'success' : 'muted'}>{status?.present ? 'installed' : 'not installed'}</Badge>
            {sizeMb && <span className="text-muted-foreground">{sizeMb} MB</span>}
            {status?.modifiedAt && <span className="text-muted-foreground">· updated {new Date(status.modifiedAt).toLocaleString()}</span>}
          </div>
          {status?.loadError && status.loadError !== 'not-found' && (
            <div className="text-destructive">⚠️ Load error: {status.loadError}</div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="geoip-url">Download URL</Label>
            <Input id="geoip-url" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[12px]" placeholder={DEFAULT_GEOIP_URL} />
            <p className="text-[11px] text-muted-foreground">
              Format <code>.mmdb</code> (mentah, cepat) atau <code>.tar.gz</code> (MaxMind official, auto-extract).
              MaxMind official butuh <code>SIBERGATE_MAXMIND_LICENSE_KEY</code> di env; mirror lain (P3TERX default) tanpa auth.
            </p>
          </div>
          <Button onClick={doDownload} disabled={update.isPending} size="sm">
            {update.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {status?.present ? 'Update now' : 'Download'}
          </Button>
          {status && !status.present && (
            <p className="text-[11px] text-muted-foreground">Tanpa GeoIP DB, proxy tetap jalan tapi flag negara tampil 🏳️ (unknown).</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
