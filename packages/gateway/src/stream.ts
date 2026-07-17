import type { Context } from 'hono';

/**
 * Proxy an upstream SSE stream to the client VERBATIM while capturing usage.
 *
 * For streaming requests the upstream already returns a valid SSE byte stream,
 * so we forward it untouched (avoids re-encoding bugs with picky clients) and
 * only decode a copy to extract the final `usage` chunk for logging.
 *
 * On client disconnect, we cancel the upstream reader so its fetch doesn't
 * linger (good hygiene; avoids leaking sockets).
 */
export interface ProxyResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export function proxySSEStream(c: Context, upstream: Response): { response: Response; done: Promise<ProxyResult> } {
  const body = upstream.body;
  if (!body) {
    return {
      response: c.json(
        { error: { message: 'Upstream returned no stream body.', type: 'internal_error', param: null, code: null } },
        502,
      ),
      done: Promise.resolve({ content: '', usage: null }),
    };
  }

  const result: ProxyResult = { content: '', usage: null };
  const reader = body.getReader();
  let resolveDone!: () => void;
  const done = new Promise<ProxyResult>((r) => (resolveDone = () => r(result)));

  let buffer = '';
  const inspect = (block: string) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') result.content += delta;
        if (chunk.usage) {
          result.usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
          };
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done: rd, value } = await reader.read();
          if (rd) break;
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            inspect(buffer.slice(0, sep));
            buffer = buffer.slice(sep + 2);
          }
        }
        if (buffer.trim()) inspect(buffer);
      } finally {
        reader.releaseLock?.();
        controller.close();
        resolveDone();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const response = c.newResponse(readable, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return { response, done };
}
