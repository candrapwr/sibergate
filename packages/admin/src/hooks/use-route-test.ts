'use client';

import { useState, useCallback } from 'react';
import { modalityEndpoint } from '@/lib/modality-endpoints';

/**
 * Test a route by sending a real chat request through the gateway and
 * capturing what happened: which provider served it (or where it failed),
 * latency, token usage, and any error.
 *
 * Uses the client key stored in localStorage (same one the Playground uses).
 * Hits the proxied /v1/chat/completions so it stays same-origin.
 */

export interface TestAttempt {
  provider: string;
  model: string;
  /** 'served' | 'failed' */
  outcome: 'served' | 'failed';
}

export interface TestResult {
  ok: boolean;
  /** The provider/model that ultimately served (or last attempted). */
  servedBy: { provider: string; model: string } | null;
  content: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** HTTP status from the gateway. */
  status: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** Best-effort failover inference from the error message text. */
  attempts: TestAttempt[];
}

/** Raw response from the mini-Postman sendRaw — status + headers + body text. */
export interface RawResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_PROMPT = 'Reply with exactly: OK';

function readClientKey(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('sibergate_client_key') ?? '';
}

export function useRouteTest() {
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const test = useCallback(async (routeId: string, clientKey?: string, prompt?: string, modality?: string) => {
    const key = clientKey || readClientKey();
    if (!key) {
      throw new Error('No client API key. Set one in the Playground first (it is saved to your browser).');
    }
    setTesting(true);
    setResult(null);
    const start = performance.now();
    const ep = modalityEndpoint(modality);
    // Generic passthrough selects the route via the path (not a `model` body
    // field), so substitute the route id into /v1/generic/{routeId}.
    const proxyPath = ep.proxyPath.replace('{routeId}', routeId);
    try {
      // Build the request body based on the route's modality.
      const p = prompt || DEFAULT_PROMPT;
      const reqBody: Record<string, unknown> = { model: routeId };
      switch (modality) {
        case 'image':
          reqBody.prompt = p; reqBody.n = 1; reqBody.size = '1024x1024';
          break;
        case 'speech':
          reqBody.input = p; reqBody.voice = 'alloy';
          break;
        case 'embed':
          reqBody.input = p;
          break;
        case 'music':
          reqBody.prompt = p;
          break;
        case 'generic':
          // Generic REST passthrough — arbitrary body (no `model` field).
          reqBody.example = p || 'payload';
          break;
        default:
          reqBody.messages = [{ role: 'user', content: p }];
          reqBody.stream = false;
      }

      const res = await fetch(`${window.location.origin}${proxyPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(reqBody),
      });

      const latencyMs = Math.round(performance.now() - start);
      const text = await res.text();
      const body = text ? safeParse(text) : null;

      if (!res.ok) {
        const errBody = body as { error?: { message?: string; code?: string } } | null;
        const errorMessage = errBody?.error?.message ?? `Request failed (${res.status})`;
        const errorCode = errBody?.error?.code ?? String(res.status);
        // Infer failover attempts from the error message (the gateway reports
        // which provider returned the error).
        const attempts = inferAttempts(errorMessage);
        return {
          ok: false,
          servedBy: attempts.length > 0 ? { provider: attempts[attempts.length - 1]!.provider, model: attempts[attempts.length - 1]!.model } : null,
          content: '',
          latencyMs,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          status: res.status,
          errorCode,
          errorMessage,
          attempts,
        } as TestResult;
      }

      const json = body as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      const r: TestResult = {
        ok: true,
        servedBy: null, // filled below: gateway doesn't echo provider in success; infer from logs
        content,
        latencyMs,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
        status: res.status,
        errorCode: null,
        errorMessage: null,
        attempts: [],
      };
      setResult(r);
      // Best-effort: look up which provider served from the most recent log.
      fetch(`${window.location.origin}/api/admin/logs?limit=1`)
        .then((lr) => lr.json())
        .then((lr) => {
          const log = lr?.data?.[0];
          if (log?.provider) {
            setResult((prev) =>
              prev ? { ...prev, servedBy: { provider: log.provider, model: log.model ?? '' }, attempts: [{ provider: log.provider, model: log.model ?? '', outcome: 'served' }] } : prev,
            );
          }
        })
        .catch(() => {});
      return r;
    } finally {
      setTesting(false);
    }
  }, []);

  /**
   * Mini-Postman send: execute an explicit request (method/path/headers/body)
   * and return the raw response (status, headers, body text, latency). Routes
   * through /api/v1/* so it works without a client key (admin key auto-injected
   * when no Authorization header is supplied).
   */
  const sendRaw = useCallback(async (opts: {
    method: string;
    proxyPath: string; // e.g. /api/v1/chat/completions or /api/v1/generic/{id}
    headers: Array<{ key: string; value: string }>;
    body: string;
  }): Promise<RawResult> => {
    setTesting(true);
    setResult(null);
    const start = performance.now();
    try {
      const headers: Record<string, string> = {};
      for (const h of opts.headers) {
        if (h.key.trim()) headers[h.key.trim()] = h.value;
      }
      const hasBody = opts.body.trim().length > 0 && opts.method !== 'GET' && opts.method !== 'HEAD';
      const res = await fetch(`${window.location.origin}${opts.proxyPath}`, {
        method: opts.method,
        headers,
        body: hasBody ? opts.body : undefined,
      });
      const latencyMs = Math.round(performance.now() - start);
      const text = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { ok: res.ok, status: res.status, statusText: res.statusText, latencyMs, headers: respHeaders, body: text };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      return { ok: false, status: 0, statusText: 'Network error', latencyMs, headers: {}, body: (err as Error).message };
    } finally {
      setTesting(false);
    }
  }, []);

  return { test, result, testing, setResult, sendRaw };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The gateway error message includes "<provider> returned <status>…".
 * We don't know the full failover path from the error alone, but the last-named
 * provider is the one that failed last. Mark it as a failed attempt.
 */
function inferAttempts(errorMessage: string): TestAttempt[] {
  const match = errorMessage.match(/^([a-z0-9_-]+)\s+returned\s+\d+/i);
  if (match) {
    return [{ provider: match[1]!, model: '', outcome: 'failed' as const }];
  }
  return [];
}
