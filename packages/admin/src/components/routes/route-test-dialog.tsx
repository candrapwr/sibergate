'use client';

import { useState } from 'react';
import { FlaskConical, Play, Loader2, CheckCircle2, XCircle, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { Route } from '@/lib/types';
import { useRouteTest, type TestResult } from '@/hooks/use-route-test';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { formatMs, formatNum } from '@/lib/utils';
import { defaultPromptFor } from '@/lib/code-samples';

/**
 * Inline route tester: send a probe request through the gateway and visualize
 * which target served it, the latency, token usage, and any failover that
 * occurred. Helps validate a route's config without leaving the Routes page.
 */
export function RouteTestDialog({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const [clientKey, setClientKey] = useState('');
  const [prompt, setPrompt] = useState(defaultPromptFor(route.modality));
  const { test, result, testing } = useRouteTest();
  const isTranscribe = route.modality === 'transcribe';

  const run = async () => {
    try {
      const r = await test(route.id, clientKey || undefined, prompt, route.modality);
      if (r.ok) toast.success(`Served by ${r.servedBy?.provider ?? 'gateway'} in ${formatMs(r.latencyMs)}`);
      else toast.error(r.errorMessage ?? 'Test failed');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) (test as any); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Test route">
          <FlaskConical size={14} className="text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical size={15} /> Test route: <span className="font-mono">{route.id}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tkey">Client API key</Label>
            <Input
              id="tkey"
              type="password"
              value={clientKey}
              onChange={(e) => setClientKey(e.target.value)}
              placeholder="sg_live_… (uses saved key if blank)"
              className="text-[12px]"
            />
          </div>
          {!isTranscribe && (
            <div className="space-y-1.5">
              <Label htmlFor="tprompt">{route.modality === 'embed' ? 'Input text' : 'Probe prompt'}</Label>
              <Input id="tprompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-[12px]" />
            </div>
          )}

          <Button onClick={run} disabled={testing} className="w-full">
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {testing ? 'Testing…' : 'Run test'}
          </Button>

          {result && <ResultPanel route={route} result={result} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultPanel({ route, result }: { route: Route; result: TestResult }) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-3">
      {/* Outcome banner */}
      <div className="flex items-center gap-2">
        {result.ok ? (
          <CheckCircle2 size={16} className="text-success" />
        ) : (
          <XCircle size={16} className="text-destructive" />
        )}
        <span className="text-[13px] font-medium">{result.ok ? 'Success' : 'Failed'}</span>
        <Badge variant="muted" className="ml-auto">{result.status}</Badge>
      </div>

      {/* Served by + latency */}
      {result.servedBy && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">Served by:</span>
          <Badge variant="success" className="font-mono">{result.servedBy.provider}:{result.servedBy.model || '?'}</Badge>
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Zap size={12} /> {formatMs(result.latencyMs)}
          </span>
        </div>
      )}
      {!result.ok && !result.servedBy && (
        <div className="text-[12px] text-muted-foreground">No provider reached.</div>
      )}

      {/* Failover visualization */}
      {result.attempts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Path</div>
          <div className="flex flex-wrap items-center gap-1">
            {result.attempts.map((a, i) => (
              <span key={i} className="flex items-center gap-1">
                <Badge variant={a.outcome === 'served' ? 'success' : 'destructive'} className="font-mono text-[10px]">
                  {a.provider}:{a.model || '?'}
                </Badge>
                {i < result.attempts.length - 1 && <span className="text-muted-foreground">→</span>}
              </span>
            ))}
          </div>
          {result.ok && result.attempts.length === 1 && (
            <p className="text-[10px] text-muted-foreground">Primary target served on first try.</p>
          )}
        </div>
      )}

      {/* Configured targets reminder */}
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Configured targets ({route.strategy})</div>
        <div className="flex flex-wrap gap-1">
          {route.targets.map((t, i) => (
            <Badge key={i} variant="outline" className="font-mono text-[10px]">
              {t.provider}:{t.model}
            </Badge>
          ))}
        </div>
      </div>

      {/* Tokens */}
      {result.totalTokens > 0 && (
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          <span>{formatNum(result.promptTokens)} in</span>
          <span>{formatNum(result.completionTokens)} out</span>
          <span>{formatNum(result.totalTokens)} total</span>
        </div>
      )}

      {/* Response content */}
      {result.content && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Response</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-[11px]">
            {result.content}
          </pre>
        </div>
      )}

      {/* Error detail */}
      {result.errorMessage && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-destructive">Error ({result.errorCode})</div>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-[11px] text-destructive">
            {result.errorMessage}
          </pre>
        </div>
      )}
    </div>
  );
}
