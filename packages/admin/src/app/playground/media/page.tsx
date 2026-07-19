'use client';

import { useState, useEffect } from 'react';
import { ImageIcon, Volume2, Music, Loader2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { useRoutes } from '@/lib/queries';
import type { RouteModality } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Tab = 'image' | 'speech' | 'music';

const TABS: Array<{ id: Tab; label: string; icon: typeof ImageIcon; modality: RouteModality }> = [
  { id: 'image', label: 'Image', icon: ImageIcon, modality: 'image' },
  { id: 'speech', label: 'Speech', icon: Volume2, modality: 'speech' },
  { id: 'music', label: 'Music', icon: Music, modality: 'music' },
];

export default function MediaPlaygroundPage() {
  const { data: routesData } = useRoutes();
  const routes = routesData?.data ?? [];
  const [tab, setTab] = useState<Tab>('image');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('sibergate_client_key');
    if (saved) setApiKey(saved);
  }, []);

  const routesForTab = routes.filter((r) => (r.modality ?? 'chat') === tab);

  return (
    <div className="space-y-6">
      <PageHeader title="Media Playground" subtitle="Test image, speech & music routes" />

      {/* Tabs */}
      <div className="flex gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
                active ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {routesForTab.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-[13px] text-muted-foreground">
            No {tab} routes yet. Create one on the Routes page (modality = {tab}).
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="space-y-1.5">
                <Label>Client API key</Label>
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sg_live_…" className="text-[12px]" />
              </div>
            </CardContent>
          </Card>

          {tab === 'image' && <ImageGen routes={routesForTab.map((r) => r.id)} apiKey={apiKey} />}
          {tab === 'speech' && <SpeechGen routes={routesForTab.map((r) => r.id)} apiKey={apiKey} />}
          {tab === 'music' && <MusicGen routes={routesForTab.map((r) => r.id)} apiKey={apiKey} />}
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────── Image ──────────────────────────────── */
function ImageGen({ routes, apiKey }: { routes: string[]; apiKey: string }) {
  const [route, setRoute] = useState(routes[0] ?? '');
  const [prompt, setPrompt] = useState('A serene mountain landscape at sunset');
  const [size, setSize] = useState('1024x1024');
  const [loading, setLoading] = useState(false);
  const [img, setImg] = useState<string | null>(null);

  useEffect(() => { if (routes.length && !routes.includes(route)) setRoute(routes[0]); }, [routes, route]);

  const run = async () => {
    setLoading(true); setImg(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch('/api/v1/images/generations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: route, prompt, size, n: 1 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `Error ${res.status}`);
      const d = json.data?.[0];
      setImg(d?.url ?? (d?.b64_json ? `data:image/png;base64,${d.b64_json}` : null));
      toast.success('Image generated');
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Route</Label>
            <select value={route} onChange={(e) => setRoute(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
              {routes.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Size</Label>
            <select value={size} onChange={(e) => setSize(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
              <option>1024x1024</option><option>1792x1024</option><option>1024x1792</option>
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Prompt</Label>
          <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-[12px]" />
        </div>
        <Button onClick={run} disabled={loading}>{loading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />} Generate</Button>
        {img && (
          <div className="space-y-2">
            <img src={img} alt="generated" className="max-w-full rounded-md border border-border" />
            <a href={img} download="sibergate-image.png" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
              <Download size={12} /> Download
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────── Speech ─────────────────────────────── */
function SpeechGen({ routes, apiKey }: { routes: string[]; apiKey: string }) {
  const [route, setRoute] = useState(routes[0] ?? '');
  const [text, setText] = useState('Hello from SiberGate.');
  const [voice, setVoice] = useState('alloy');
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);

  useEffect(() => { if (routes.length && !routes.includes(route)) setRoute(routes[0]); }, [routes, route]);

  const run = async () => {
    setLoading(true); setAudio(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch('/api/v1/audio/speech', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: route, input: text, voice, response_format: 'mp3' }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(j?.error?.message ?? `Error ${res.status}`); }
      const blob = await res.blob();
      setAudio(URL.createObjectURL(blob));
      toast.success('Speech generated');
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Route</Label>
            <select value={route} onChange={(e) => setRoute(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
              {routes.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Voice</Label>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
              {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => <option key={v}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Text</Label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-border bg-background px-3 py-2 text-[12px]" />
        </div>
        <Button onClick={run} disabled={loading}>{loading ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />} Generate</Button>
        {audio && <audio controls src={audio} className="w-full" />}
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────── Music ──────────────────────────────── */
function MusicGen({ routes, apiKey }: { routes: string[]; apiKey: string }) {
  const [route, setRoute] = useState(routes[0] ?? '');
  const [prompt, setPrompt] = useState('Upbeat electronic dance track with heavy bass');
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);

  useEffect(() => { if (routes.length && !routes.includes(route)) setRoute(routes[0]); }, [routes, route]);

  const run = async () => {
    setLoading(true); setAudio(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch('/api/v1/music/generations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: route, prompt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `Error ${res.status}`);
      const src = json.audio ?? '';
      // audio may be a data-uri or a URL.
      setAudio(src.startsWith('data:') ? src : src);
      toast.success('Music generated');
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="space-y-1.5">
          <Label>Route</Label>
          <select value={route} onChange={(e) => setRoute(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Prompt</Label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-[12px]" />
        </div>
        <Button onClick={run} disabled={loading}>{loading ? <Loader2 size={14} className="animate-spin" /> : <Music size={14} />} Generate</Button>
        {audio && <audio controls src={audio} className="w-full" />}
      </CardContent>
    </Card>
  );
}
