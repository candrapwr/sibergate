'use client';

import { useMemo, useState } from 'react';
import { FlaskConical, Play, Loader2, Plus, Trash2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { Route } from '@/lib/types';
import { useRouteTest, type RawResult } from '@/hooks/use-route-test';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { formatMs } from '@/lib/utils';
import { modalityEndpoint } from '@/lib/modality-endpoints';
import { bodyForModality, detectBaseUrl, buildCurlPreview } from '@/lib/code-samples';

/**
 * Inline mini-Postman: edit the request (method/URL/headers/body), preview the
 * generated curl, run it against the gateway, and inspect the raw response —
 * status, latency, response headers, and body. Replaces the old simple tester.
 *
 * Routes through /api/v1/* so it works with no client key (the proxy injects
 * the admin key for the logged-in operator). Supply an Authorization header to
 * test a real sg_live_* client key instead.
 */
export function RouteTestDialog({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const modality = route.modality ?? 'chat';
  const ep = modalityEndpoint(modality);

  // Default method: generic supports any, others are POST (OpenAI shape).
  const defaultMethod = modality === 'generic' ? 'POST' : 'POST';
  const [method, setMethod] = useState(defaultMethod);

  // Proxy path: route through /api/v1/* (admin-key fallback when no Authorization).
  const defaultProxyPath = useMemo(() => {
    const p = ep.proxyPath.replace('{routeId}', route.id);
    return p.startsWith('/v1/') ? `/api${p}` : p;
  }, [ep.proxyPath, route.id]);
  const [path, setPath] = useState(defaultProxyPath);

  // The "external" URL shown in the curl preview (gateway base + the /v1 path).
  const baseUrl = detectBaseUrl();
  const externalUrl = useMemo(() => {
    const v1Path = path.replace(/^\/api\//, '/');
    return `${baseUrl}${v1Path}`;
  }, [path, baseUrl]);

  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([
    { key: 'Content-Type', value: 'application/json' },
  ]);
  const [body, setBody] = useState(() => {
    if (modality === 'generic') return '{\n  "example": "payload"\n}';
    if (modality === 'transcribe') return ''; // multipart, no JSON body
    return bodyForModality({ routeId: route.id, modality, baseUrl, apiKey: 'sg_live_...' });
  });

  const { sendRaw, testing } = useRouteTest();
  const [result, setResult] = useState<RawResult | null>(null);
  const [copied, setCopied] = useState(false);

  const curlPreview = buildCurlPreview({ method, url: externalUrl, headers, body });

  const run = async () => {
    try {
      const r = await sendRaw({ method, proxyPath: path, headers, body });
      setResult(r);
      if (r.ok) toast.success(`${r.status} in ${formatMs(r.latencyMs)}`);
      else if (r.status === 0) toast.error(r.statusText || 'Network error');
      else toast.error(`${r.status} ${r.statusText}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const copyCurl = () => {
    navigator.clipboard.writeText(curlPreview);
    setCopied(true);
    toast.success('cURL copied');
    setTimeout(() => setCopied(false), 2000);
  };

  const showBody = method !== 'GET' && method !== 'HEAD';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Test route (Postman)">
          <FlaskConical size={14} className="text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical size={15} /> Test route: <span className="font-mono">{route.id}</span>
            <Badge variant="muted" className="ml-1">{modality}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Method + path */}
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="h-9 w-28 rounded-md border border-border bg-background px-2 text-[12px] font-mono"
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="flex-1 font-mono text-[12px]" />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Path is relative to this dashboard (proxied to the gateway). External URL for curl: <code className="font-mono">{externalUrl}</code>
          </p>

          {/* Headers */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Headers</Label>
              <button type="button" onClick={() => setHeaders([...headers, { key: '', value: '' }])} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                <Plus size={11} /> Add
              </button>
            </div>
            <div className="space-y-1.5">
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={h.key}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    placeholder="Header-Name"
                    className="font-mono text-[12px]"
                  />
                  <Input
                    value={h.value}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    placeholder="value"
                    className="flex-1 font-mono text-[12px]"
                  />
                  <button type="button" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} className="px-1 text-muted-foreground hover:text-destructive">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">Leave Authorization empty to run as admin. Add <code className="font-mono">Authorization: Bearer sg_live_…</code> to test a client key.</p>
          </div>

          {/* Body */}
          {showBody && (
            <div className="space-y-1.5">
              <Label>Body (JSON)</Label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                spellCheck={false}
                className="w-full rounded-md border border-border bg-[hsl(220_13%_7%)] p-2 font-mono text-[11px] leading-relaxed text-foreground"
              />
            </div>
          )}

          {/* cURL preview */}
          <div className="relative">
            <Label>cURL preview</Label>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-[hsl(220_13%_7%)] p-2 pr-10 font-mono text-[11px] text-foreground">
              {curlPreview}
            </pre>
            <Button onClick={copyCurl} size="icon" variant="outline" className="absolute right-2 top-7 h-7 w-7" title="Copy curl">
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </Button>
          </div>

          <Button onClick={run} disabled={testing} className="w-full">
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {testing ? 'Running…' : 'Run'}
          </Button>

          {result && <ResponsePanel result={result} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResponsePanel({ result }: { result: RawResult }) {
  const isJson = result.headers['content-type']?.includes('json') || result.body.trimStart().startsWith('{') || result.body.trimStart().startsWith('[');
  const prettyBody = useMemo(() => {
    if (!isJson) return result.body;
    try { return JSON.stringify(JSON.parse(result.body), null, 2); } catch { return result.body; }
  }, [result.body, isJson]);

  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-3">
      {/* Status line */}
      <div className="flex items-center gap-2">
        <Badge variant={result.ok ? 'success' : 'destructive'}>{result.status} {result.statusText}</Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">{formatMs(result.latencyMs)}</span>
      </div>

      {/* Response headers */}
      {Object.keys(result.headers).length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">Response headers ({Object.keys(result.headers).length})</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-card p-2 font-mono text-[10px]">
            {Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
          </pre>
        </details>
      )}

      {/* Body */}
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Response body</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-[11px]">
          {prettyBody || '(empty)'}
        </pre>
      </div>
    </div>
  );
}
