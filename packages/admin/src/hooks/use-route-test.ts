'use client';

import { useState, useCallback } from 'react';

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

const DEFAULT_PROMPT = 'Reply with exactly: OK';

function readClientKey(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('sibergate_client_key') ?? '';
}

export function useRouteTest() {
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const test = useCallback(async (routeId: string, clientKey?: string, prompt?: string) => {
    const key = clientKey || readClientKey();
    if (!key) {
      throw new Error('No client API key. Set one in the Playground first (it is saved to your browser).');
    }
    setTesting(true);
    setResult(null);
    const start = performance.now();
    try {
      const res = await fetch(`${window.location.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: routeId,
          messages: [{ role: 'user', content: prompt || DEFAULT_PROMPT }],
          stream: false,
        }),
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

  return { test, result, testing, setResult };
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
