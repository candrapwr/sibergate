'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useRoutes } from '@/lib/queries';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  meta?: { provider?: string; model?: string; latencyMs?: number; tokens?: number; error?: boolean };
}

export default function PlaygroundPage() {
  const { data: routesData } = useRoutes();
  const routes = routesData?.data ?? [];
  const [route, setRoute] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [stream, setStream] = useState(true);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('sibergate_client_key');
    if (saved) setApiKey(saved);
    if (routes[0]) setRoute(routes[0].id);
  }, [routes]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || !route) {
      toast.error('Set route and message first');
      return;
    }
    if (apiKey) localStorage.setItem('sibergate_client_key', apiKey);
    const userMsg: Msg = { role: 'user', content: input };
    const assistantMsg: Msg = { role: 'assistant', content: '', meta: {} };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput('');
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const start = performance.now();
    try {
      // Route through /api/v1/* so the request works with or without a client
      // key: the proxy injects the admin key when no Authorization is supplied.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${window.location.origin}/api/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: route, messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })), stream }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const msg = errBody?.error?.message ?? `Error ${res.status}`;
        setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content: msg, meta: { error: true } } : mm)));
        return;
      }

      if (stream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let provider = '', model = '', tokens = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;
              try {
                const chunk = JSON.parse(data);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') {
                  assistantMsg.content += delta;
                  setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content: assistantMsg.content } : mm)));
                }
                if (chunk.usage) tokens = chunk.usage.total_tokens ?? tokens;
              } catch { /* ignore */ }
            }
          }
        }
        setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, meta: { provider, model, latencyMs: Math.round(performance.now() - start), tokens } } : mm)));
      } else {
        const json = await res.json();
        const content = json.choices?.[0]?.message?.content ?? '';
        const tokens = json.usage?.total_tokens;
        setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content, meta: { latencyMs: Math.round(performance.now() - start), tokens } } : mm)));
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content: (err as Error).message, meta: { error: true } } : mm)));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <div className="space-y-6">
      <PageHeader title="Playground" subtitle="Test routes — streamed live from the gateway" />

      <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
        {/* Chat */}
        <Card className="flex h-[calc(100vh-220px)] flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                <MessageSquare size={28} strokeWidth={1.5} />
                <p className="mt-2 text-sm">Send a message to test a route</p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-2 text-[13px] ${m.role === 'user' ? 'bg-primary text-primary-foreground' : m.meta?.error ? 'bg-destructive/15 text-destructive' : 'bg-secondary'}`}>
                    <div className="whitespace-pre-wrap">{m.content || (sending && i === messages.length - 1 ? '…' : '')}</div>
                    {m.meta?.latencyMs != null && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5 border-t border-border/40 pt-1.5 text-[10px] opacity-70">
                        {m.meta.provider && <Badge variant="muted" className="text-[9px]">{m.meta.provider}:{m.meta.model}</Badge>}
                        <span>{m.meta.latencyMs}ms</span>
                        {m.meta.tokens ? <span>{m.meta.tokens} tok</span> : null}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="border-t border-border p-3">
            <div className="flex gap-2">
              <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Type a message…" disabled={sending} />
              {sending ? (
                <Button variant="outline" onClick={stop}>Stop</Button>
              ) : (
                <Button onClick={send}><Send size={14} /></Button>
              )}
            </div>
          </div>
        </Card>

        {/* Config */}
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <Label>Route</Label>
              <select value={route} onChange={(e) => setRoute(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-[12px]">
                {routes.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.strategy}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Client API key <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="blank = use admin key" className="text-[12px]" />
              <p className="text-[10px] text-muted-foreground">Leave blank to run as the logged-in admin. Stored in your browser only.</p>
            </div>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
              Stream response
            </label>
            <Button variant="outline" size="sm" className="w-full" onClick={() => setMessages([])}>Clear chat</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
