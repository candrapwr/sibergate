'use client';

import { useState } from 'react';
import { Code2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { Route } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { generateSample, detectBaseUrl, languagesForModality, defaultPromptFor, type Language } from '@/lib/code-samples';

/**
 * "Get code" dialog for a route — Postman-style sample snippets.
 *
 * Shows ready-to-run client code (cURL, Node, Python, PHP, Go) that calls the
 * gateway using THIS route id as the `model`. The user supplies their client
 * key (it is never stored; we default to a placeholder). A banner clarifies
 * that the route id is what clients pass as `model`.
 */
export function RouteCodeDialog({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('sg_live_xxxxxxxxxxxxxxxx');
  const [baseUrl, setBaseUrl] = useState(detectBaseUrl());
  const [prompt, setPrompt] = useState(defaultPromptFor(route.modality));
  const [copied, setCopied] = useState(false);

  const langs = languagesForModality(route.modality);
  const [lang, setLang] = useState<Language>('curl');
  const isTranscribe = route.modality === 'transcribe';

  const code = generateSample(lang, { routeId: route.id, modality: route.modality, baseUrl, apiKey, prompt });

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Get sample code">
          <Code2 size={14} className="text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Code2 size={15} /> Sample code — route <span className="font-mono">{route.id}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Clarifier banner */}
        <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-[12px] text-foreground">
          Clients call this route as the <code className="rounded bg-primary/20 px-1 py-0.5 font-mono">model</code> field — e.g.
          <code className="ml-1 rounded bg-primary/20 px-1 py-0.5 font-mono">{"{ \"model\": \""}{route.id}{"\" }"}</code>.
          It is <strong>not</strong> the upstream vendor model id.
        </div>

        {/* Config inputs */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="curl-base">Base URL</Label>
            <Input id="curl-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="text-[12px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="curl-key">Client API key</Label>
            <Input id="curl-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="text-[12px]" />
          </div>
        </div>
        {!isTranscribe && (
          <div className="space-y-1.5">
            <Label htmlFor="curl-prompt">{route.modality === 'embed' ? 'Input text' : 'Prompt'}</Label>
            <Input id="curl-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-[12px]" />
          </div>
        )}

        {/* Language tabs (stream only shown for chat) */}
        <div className="flex flex-wrap gap-1">
          {langs.map((l) => (
            <button
              key={l.id}
              onClick={() => setLang(l.id)}
              className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                lang === l.id ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>

        {/* Code block — width-clamped so long lines scroll horizontally */}
        <div className="relative min-w-0 max-w-full overflow-hidden">
          <pre className="max-h-72 w-full max-w-full overflow-x-auto overflow-y-auto whitespace-pre rounded-md border border-border bg-[hsl(220_13%_7%)] p-3 pr-12 font-mono text-[11px] leading-relaxed text-foreground">
            {code}
          </pre>
          <Button
            onClick={copy}
            size="icon"
            variant="outline"
            className="absolute right-2 top-2 h-7 w-7"
            title="Copy"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
