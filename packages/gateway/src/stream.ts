import type { Context } from 'hono';
import { convertResponsesStreamEventToChatChunk } from '@sibergate/core';

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

/**
 * Proxy upstream SSE stream Responses API → chat/completions SSE, sambil capture
 * usage. Dipakai ketika route target modality='responses' dan client minta
 * streaming.
 *
 * Format Responses API memakai event types:
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 *
 *   event: response.completed
 *   data: {"response":{"usage":{"input_tokens":..,"output_tokens":..}}}
 *
 * Output ke client = chat SSE chunk:
 *   data: {"choices":[{"delta":{"content":"Hello"}}]}
 *
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
 *
 *   data: [DONE]
 */
export function proxyResponsesSSEStream(
  c: Context,
  upstream: Response,
  modelId: string,
): { response: Response; done: Promise<ProxyResult> } {
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

  // SSE adalah baris-baris dipisah blank line. Satu "event block" punya
  // kemungkinan baris `event: <type>` + satu atau lebih `data: <json>`.
  // Data multi-baris digabung sebelum parse.
  const encoder = new TextEncoder();
  const writeChunk = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done: rd, value } = await reader.read();
          if (rd) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            processBlock(block, controller);
          }
        }
        if (buffer.trim()) processBlock(buffer, controller);
        // SSE terminator standar chat/completions.
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        // Upstream error mid-stream: kirim pesan error sebagai chunk terakhir.
        const msg = err instanceof Error ? err.message : 'stream error';
        writeChunk(controller, { error: { message: msg, type: 'upstream_error' } });
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

  // Parse satu event block Responses → convert → kirim ke client.
  function processBlock(block: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    let eventType = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!eventType || dataLines.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return; // data non-JSON, skip.
    }
    const { chunk, usage } = convertResponsesStreamEventToChatChunk(eventType, payload, modelId);
    if (chunk) {
      writeChunk(controller, chunk);
      // Akumulasi content utk result.content (dipakai estimateTokens fallback).
      const delta = (chunk as any).choices?.[0]?.delta?.content;
      if (typeof delta === 'string') result.content += delta;
    }
    if (usage) {
      result.usage = usage;
    }
  }

  const response = c.newResponse(readable, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return { response, done };
}
