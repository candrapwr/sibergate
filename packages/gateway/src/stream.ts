import type { Context } from 'hono';
import { createResponsesStreamConverter, createToolsTextStreamConverter, storeSignature } from '@sibergate/core';

/**
 * Proxy an upstream SSE stream to the client while capturing usage.
 *
 * Dua mode (dipilih by providerId):
 *   - **Non-Gemini (default)**: forward bytes VERBATIM (zero risk utk client
 *     picky), decode copy utk extract `usage` utk logging.
 *   - **Gemini/openrouter**: parse → transform → re-emit tiap block. Transform:
 *     (1) capture + strip `extra_content.google.thought_signature` dari tool_call
 *         delta (signature wajib utk multi-turn; client dapat format OpenAI murni),
 *     (2) fix `finish_reason` — Gemini streaming tool call kadang kirim "stop"
 *         padahal model memanggil tool; klien melihat "stop" & mengira selesai,
 *         lalu tool call tidak dieksekusi (terlihat "stuck"). Koreksi jadi
 *         "tool_calls" bila di stream ini ada tool_call.
 *
 * On client disconnect, we cancel the upstream reader so its fetch doesn't
 * linger (good hygiene; avoids leaking sockets).
 */
export interface ProxyResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens?: number; total_tokens: number } | null;
}

export function proxySSEStream(
  c: Context,
  upstream: Response,
  providerId?: string,
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

  // Gemini-via-OpenRouter juga emit field google.extra_content → perlakukan sama.
  const isGemini = providerId === 'gemini' || providerId === 'openrouter';
  // Track apakah di stream ini pernah muncul tool_call (utk fix finish_reason),
  // dan map id→index utk inject field `index` di tool_call delta Gemini (spec
  // OpenAI streaming wajib `index` utk aggregate argumen parsial).
  let sawToolCall = false;
  const tcIndexMap: Record<string, number> = {};
  let nextTcIndex = 0;
  const encoder = new TextEncoder();

  /** Extract usage + content dari block (shared oleh kedua mode). */
  const trackUsage = (block: string) => {
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

  /**
   * Transform sebuah SSE block utk Gemini: capture+strip signature, fix
   * finish_reason. Return block hasil (re-serialized bila diubah, apa adana bila
   * tidak). Mutate terjadi pada parsed chunk (deep), jadi re-serialize utk kirim.
   */
  const transformGeminiBlock = (block: string): string => {
    const lines = block.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      // Track usage + content (sama dgn trackUsage, dijalankan di sini utk Gemini).
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content;
      if (typeof content === 'string') result.content += content;
      if (chunk.usage) {
        result.usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        };
      }
      // Strip extra_content.google dari delta level (Gemini menempel signature
      // tidak hanya di tool_calls, tapi juga di delta/message content biasa utk
      // model reasoning). Field ini non-OpenAI — bocor ke client bila tidak dihapus.
      if (delta?.extra_content) {
        delete delta.extra_content;
        changed = true;
      }
      // Capture + strip thought_signature dari tool_call delta, DAN inject field
      // `index` (OpenAI streaming spec WAJIB utk aggregate argumen parsial).
      // Gemini tidak sertakan `index` di delta streaming → client yg match by
      // index (mis. SiberFlow) tidak bisa aggregate → spinner tool call stuck.
      // Map id→index konsisten sepanjang stream supaya argumen tambahan nyambung.
      const toolCalls = delta?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        sawToolCall = true;
        for (let ti = 0; ti < toolCalls.length; ti++) {
          const tc = toolCalls[ti];
          if (!tc) continue;
          const sig = tc.extra_content?.google?.thought_signature;
          if (typeof sig === 'string' && sig && tc.id) {
            storeSignature(tc.id, sig, providerId ?? 'unknown');
          }
          if (tc.extra_content) {
            delete tc.extra_content;
            changed = true;
          }
          // Inject index: pakai posisi dlm delta bila ada, atau map by id utk
          // konsistensi antar chunk (argumen parsial datang dgn id sama).
          if (tc.index === undefined) {
            const idKey = tc.id ?? `__pos${ti}`;
            if (!(idKey in tcIndexMap)) tcIndexMap[idKey] = nextTcIndex++;
            tc.index = tcIndexMap[idKey];
            changed = true;
          } else if (tc.id && !(tc.id in tcIndexMap)) {
            tcIndexMap[tc.id] = tc.index;
          }
        }
      }
      // Fix finish_reason: Gemini streaming tool call kadang kirim "stop" padahal
      // ada tool_call → klien mengira selesai & tool tidak dieksekusi (stuck).
      // OpenAI spec: bila ada tool_call, finish_reason HARUS "tool_calls".
      const choice = chunk.choices?.[0];
      if (choice && choice.finish_reason === 'stop' && sawToolCall) {
        choice.finish_reason = 'tool_calls';
        changed = true;
      }
      if (changed) lines[i] = `data: ${JSON.stringify(chunk)}`;
    }
    return changed ? lines.join('\n') : block;
  };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done: rd, value } = await reader.read();
          if (rd) break;
          if (isGemini) {
            // Mode transform: decode → proses per block → re-emit.
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              controller.enqueue(encoder.encode(transformGeminiBlock(block) + '\n\n'));
            }
          } else {
            // Mode verbatim: forward bytes apa adanya, inspect copy utk usage.
            controller.enqueue(value);
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              trackUsage(buffer.slice(0, sep));
              buffer = buffer.slice(sep + 2);
            }
          }
        }
        // Flush sisa buffer (block terakhir tanpa trailing \n\n).
        if (buffer.trim()) {
          if (isGemini) controller.enqueue(encoder.encode(transformGeminiBlock(buffer) + '\n\n'));
          else trackUsage(buffer);
        }
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

  // Converter stateful per-stream — track tool_call index mapping (lihat
  // createResponsesStreamConverter utk alasan kenapa perlu state).
  const converter = createResponsesStreamConverter(modelId);

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
    const { chunk, usage } = converter.processEvent(eventType, payload);
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

/**
 * Proxy upstream chat/completions SSE → client, sambil re-parse text content ke
 * format OpenAI tool_calls via XML `<tool_call>` pattern. Dipakai saat route target
 * modality='tools-text' (tool calling via text generation).
 *
 * Upstream stream = chat-completions SSE standar (data: JSON dgn delta.content).
 * Tiap delta.content (text yg mungkin mengandung tag XML) di-feed ke stateful
 * converter, yg emit chunk OpenAI ({content} atau {tool_calls[].function.arguments}).
 *
 * Mirip proxyResponsesSSEStream (struktur ReadableStream + block split + writeChunk),
 * tapi upstream-nya chat SSE (no event: lines) dan transform-nya lewat XML state machine.
 */
export function proxyToolsTextSSEStream(
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

  const converter = createToolsTextStreamConverter(modelId);
  const encoder = new TextEncoder();
  let sawToolCall = false;

  const writeChunk = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  /** Proses satu block SSE chat-completions: extract delta.content, feed converter. */
  const processBlock = (block: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    let finishReason: string | null = null;
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string') {
          // Feed text delta ke XML state machine converter.
          const converted = converter.processChunk(delta);
          for (const cc of converted) {
            if (cc.chunk) {
              writeChunk(controller, cc.chunk);
              if ((cc.chunk as any).choices?.[0]?.delta?.tool_calls) sawToolCall = true;
              const tc = (cc.chunk as any).choices?.[0]?.delta?.content;
              if (typeof tc === 'string') result.content += tc;
            }
          }
        }
        // Capture usage bila ada di chunk (beberapa provider kirim di chunk terakhir).
        if (chunk.usage) {
          result.usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
          };
        }
        // Capture finish_reason upstream (STOP/MAX_TOKENS) — akan dikoreksi di akhir.
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        /* ignore non-JSON */
      }
    }
    return finishReason;
  };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFinishReason: string | null = null;
      try {
        while (true) {
          const { done: rd, value } = await reader.read();
          if (rd) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const fr = processBlock(block, controller);
            if (fr) lastFinishReason = fr;
          }
        }
        // Flush sisa buffer.
        if (buffer.trim()) {
          const fr = processBlock(buffer, controller);
          if (fr) lastFinishReason = fr;
        }
        // Terminal chunk: koreksi finish_reason. Bila ada tool_call → 'tool_calls'
        // (OpenAI spec), walau upstream kirim 'stop'. Else pakai upstream reason.
        const finalReason = sawToolCall ? 'tool_calls' : (lastFinishReason ?? 'stop');
        writeChunk(controller, {
          id: `tt_${Math.random().toString(36).slice(2, 12)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
          ...(result.usage ? { usage: result.usage } : {}),
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
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

  const response = c.newResponse(readable, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return { response, done };
}
