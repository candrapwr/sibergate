import type { Provider, McpToolMeta } from '../types.js';
import { GatewayCallError } from '../provider.js';
import { pushConsoleLog } from '../console-log.js';
import { mcpToolsCall, type McpCallOptions } from './client.js';
import { normalizeToolCall, type NormalizedToolCall } from './normalize.js';
import { mapToToolArguments, sizeToClass } from './schema-map.js';
import { parseIntent } from '../image-mapper.js';
import { ensureHostedAssetRefs } from './upload.js';

/**
 * Alur media (image/video) di atas MCP client:
 *   1. map request OpenAI → arguments tool (schema-map, berbasis inputSchema)
 *   2. tools/call
 *   3. bila hasil async (generation_id) → poll tool polling sampai selesai
 *   4. normalisasi hasil → format OpenAI (image) / payload job (video)
 *
 * Info polling (nama tool + arg task-id) datang dari provider.mcpOptions —
 * di-auto-deteksi saat sync tools (mis. Kling: query_tasks + generation_id).
 */

export interface McpPollInfo {
  pollTool?: string;
  pollToolArg?: string;
}

const POLL_INTERVAL_MS = 5_000;
/** Batas keras polling dalam adapter (image blocking): ~10 menit. */
const POLL_MAX_ATTEMPTS = 120;

/** Tool call + normalisasi; error tool (isError) → GatewayCallError. */
export async function callToolNormalized(
  provider: Provider,
  tool: string,
  args: Record<string, unknown>,
  opts?: McpCallOptions,
): Promise<NormalizedToolCall> {
  const result = await mcpToolsCall(provider, tool, args, opts);
  const normalized = normalizeToolCall(tool, result);
  if (normalized.isError) {
    throw new GatewayCallError(
      'server_error',
      `MCP tool '${tool}' error: ${normalized.text.slice(0, 300) || '(no message)'}`,
      undefined,
      { upstreamBody: JSON.stringify(result.content).slice(0, 1000) },
    );
  }
  return normalized;
}

/** Satu langkah poll task async via tool polling (query_tasks). */
export async function pollMcpTaskOnce(
  provider: Provider,
  info: McpPollInfo,
  taskRef: string,
  opts?: McpCallOptions,
): Promise<NormalizedToolCall> {
  if (!info.pollTool) {
    throw new GatewayCallError('unsupported', `Provider MCP ${provider.id} tidak punya tool polling — set mcpOptions.pollTool.`);
  }
  const argName = info.pollToolArg ?? 'task_id';
  return callToolNormalized(provider, info.pollTool, { [argName]: taskRef }, opts);
}

function sleep(ms: number, signal: AbortSignal | undefined, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new GatewayCallError('timeout', `MCP task polling dihentikan (timeout/disconnect): ${label}`));
    }, { once: true });
  });
}

/**
 * Poll sampai completed/failed (atau timeout/signal abort). Interval 5 detik,
 * batas POLL_MAX_ATTEMPTS. Dipakai jalur image (blocking) — jalur video
 * memakai pollMcpTaskOnce per-GET agar client yang mengatur ritme.
 */
export async function pollMcpTaskUntilDone(
  provider: Provider,
  info: McpPollInfo,
  taskRef: string,
  opts?: McpCallOptions,
  onProgress?: (n: NormalizedToolCall) => void,
): Promise<NormalizedToolCall> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const normalized = await pollMcpTaskOnce(provider, info, taskRef, opts);
    onProgress?.(normalized);
    if (normalized.status === 'completed' || normalized.status === 'failed') return normalized;
    await sleep(POLL_INTERVAL_MS, opts?.signal, taskRef);
  }
  throw new GatewayCallError('timeout', `MCP task ${taskRef} belum selesai setelah ${POLL_MAX_ATTEMPTS} polling.`);
}

/* ───────────────────────────── IMAGE ───────────────────────────── */

/**
 * Bentuk payload akhir tools/call sesuai envelope tool.
 *
 * 'pairs' (Kling): {model, arguments: [{name, value}], inputs: [{name,
 * inputType:'URL', url}]} — nilai SEMUA string; slot media (image_1,
 * first_image, ...) dikirim via inputs[], bukan properti.
 * 'flat' (default): argumen sebagai properti langsung.
 */
function buildToolPayload(
  toolMeta: McpToolMeta | null | undefined,
  flatArgs: Record<string, unknown>,
  variant: string | undefined,
  imageRefs: string[],
): Record<string, unknown> {
  if (toolMeta?.argEnvelope !== 'pairs') return flatArgs;
  const { model: _model, ...rest } = flatArgs;
  const payload: Record<string, unknown> = {
    ...(variant ? { model: variant } : {}),
    arguments: Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name, value]) => ({ name, value: typeof value === 'string' ? value : String(value) })),
  };
  const slots = toolMeta.inputSlots ?? [];
  const inputs = imageRefs
    .slice(0, slots.length)
    .map((url, i) => ({ name: slots[i]!, inputType: 'URL', url }));
  if (inputs.length) payload.inputs = inputs;
  return payload;
}

/**
 * Jalur image via MCP: parse intent kanonik dari body client → map ke args
 * tool → tools/call → (poll bila async) → response OpenAI images.
 *
 * `model` bisa berupa '{tool}' (varian default) atau '{tool}@{variant}'
 * (varian model vendor — model id hasil sync). Varian juga bisa dioverride
 * klien via body `model_variant` (ekstensi SiberGate).
 */
export async function mcpImageFlow(
  provider: Provider,
  model: string,
  toolMeta: McpToolMeta | null | undefined,
  pollInfo: McpPollInfo,
  body: Record<string, unknown>,
  opts?: McpCallOptions,
): Promise<Response> {
  const { tool, variant } = splitToolModel(model, toolMeta, body);
  const intent = parseIntent(body);
  // Ref inline (data-URI/base64) → upload via file_upload jadi URL hosted;
  // input model Kling menolak non-URL absolut.
  const hostedImages = await ensureHostedAssetRefs(provider, intent.images, opts);
  const flatArgs = mapToToolArguments(toolMeta?.inputSchema, {
    prompt: intent.prompt,
    negativePrompt: intent.negativePrompt,
    sizeClass: intent.sizeClass ?? null,
    imageRefs: hostedImages,
    n: intent.n,
    model: variant,
    extra: intent.openaiExtras,
  });
  const args = buildToolPayload(toolMeta, flatArgs, variant, hostedImages);
  pushConsoleLog('info', 'mcp', `image via ${provider.id}/${tool}${variant ? ` (model ${variant})` : ''}`, {
    provider: provider.id, tool, args: redactArgs(args),
  });

  const first = await callToolNormalized(provider, tool, args, opts);

  let outcome = first;
  // Async task → poll sampai selesai (bounded oleh signal target-budget).
  // Kasus khusus: status sudah COMPLETED tapi URL aset belum ada di respons
  // submit (URL Kling = CDN signed TANPA ekstensi file) → tetap query_tasks
  // sekali utk mengambil works[] lengkap.
  if (first.taskRef && first.status !== 'failed') {
    if (first.status !== 'completed' || (!first.imageUrls.length && !first.otherUrls.length)) {
      pushConsoleLog('info', 'mcp', `image task ${first.taskRef} — polling via ${pollInfo.pollTool ?? '(none)'}`, {
        provider: provider.id, tool, taskRef: first.taskRef, firstStatus: first.status ?? 'unknown',
      });
      outcome = await pollMcpTaskUntilDone(provider, pollInfo, first.taskRef, opts);
      if (outcome.status === 'failed') {
        throw new GatewayCallError(
          'server_error',
          `MCP image task failed: ${outcome.text.slice(0, 300) || (outcome.taskStatus ?? 'unknown')}`,
          undefined,
          { upstreamBody: JSON.stringify(outcome.content).slice(0, 1000) },
        );
      }
    }
  }

  // URL aset: prefer yang terklasifikasi image; URL CDN Kling TANPA ekstensi
  // (.png/.jpg) jatuh di otherUrls — fallback ke sana (satu-satunya URL yg ada).
  const assetUrls = outcome.imageUrls.length
    ? outcome.imageUrls
    : [...outcome.otherUrls, ...outcome.imageUrls];
  const images = assetUrls.map((url) =>
    url.startsWith('data:') ? { b64_json: url.slice(url.indexOf(',') + 1) } : { url },
  );
  if (!images.length) {
    throw new GatewayCallError(
      'server_error',
      `MCP tool '${tool}' selesai tanpa mengembalikan gambar: ${outcome.text.slice(0, 400) || JSON.stringify(outcome.content).slice(0, 400)}`,
      undefined,
      { upstreamBody: JSON.stringify(outcome.content).slice(0, 1000) },
    );
  }
  return new Response(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: images,
      // Field tambahan (non-standar, opsional utk klien): jejak task/tool.
      sibergate: { provider: provider.id, tool, taskRef: outcome.taskRef ?? first.taskRef ?? null },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/* ───────────────────────────── VIDEO ───────────────────────────── */

/**
 * Jalur video via MCP: submit tool generasi (text_to_video / image_to_video)
 * dan kembalikan payload ternormalisasi. Handler /v1/videos yg membuat job &
 * respons OpenAI-style (status queued) — poll dilakukan saat GET /v1/videos/:id.
 *
 * Request OpenAI-style: { model, prompt, seconds?, size?, n?, input_reference? }
 * + ekstensi SiberGate: image / image[] (URL gambar utk image-to-video),
 * model_variant / video_model (varian model vendor, mis. kling-v2-master).
 */
export async function mcpVideoSubmit(
  provider: Provider,
  model: string,
  toolMeta: McpToolMeta | null | undefined,
  pollInfo: McpPollInfo,
  body: Record<string, unknown>,
  opts?: McpCallOptions,
): Promise<NormalizedToolCall> {
  const { tool, variant } = splitToolModel(model, toolMeta, body, ['video_model']);
  const imageRefs = await ensureHostedAssetRefs(provider, [
    ...([body.input_reference].flat().filter((x): x is string => typeof x === 'string' && !!x.trim())),
    ...([body.image].flat().filter((x): x is string => typeof x === 'string' && !!x.trim())),
  ], opts);
  const seconds = body.seconds !== undefined ? Number(body.seconds) : body.duration !== undefined ? Number(body.duration) : undefined;
  const size = typeof body.size === 'string' ? body.size : undefined;

  const flatArgs = mapToToolArguments(toolMeta?.inputSchema, {
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    sizeClass: sizeToClass(size ?? ''),
    duration: seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined,
    imageRefs,
    n: typeof body.n === 'number' && Number.isFinite(body.n) ? Math.trunc(body.n) : undefined,
    model: variant,
  });
  const args = buildToolPayload(toolMeta, flatArgs, variant, imageRefs);
  if (!Object.keys(args).length) {
    throw new GatewayCallError('client_error', `Request video tidak menghasilkan argumen apa pun utk tool '${tool}' (prompt kosong / schema tidak dikenal).`);
  }
  pushConsoleLog('info', 'mcp', `video submit via ${provider.id}/${tool}${variant ? ` (model ${variant})` : ''}`, {
    provider: provider.id, tool, args: redactArgs(args),
  });
  return callToolNormalized(provider, tool, args, opts);
}

/**
 * Pisahkan id model target menjadi (tool, variant):
 *   'text_to_image@kling-v2-master' → tool 'text_to_image', variant dari
 *   modelMeta.modelVariant ATAU suffix '@'.
 * Varian bisa dioverride klien via body `model_variant` (atau alias lain,
 * mis. `video_model` di jalur video) — prioritas: override klien > meta
 * target > suffix id.
 */
function splitToolModel(
  model: string,
  toolMeta: McpToolMeta | null | undefined,
  body: Record<string, unknown>,
  aliasFields: string[] = [],
): { tool: string; variant: string | undefined } {
  const at = model.indexOf('@');
  const tool = at >= 0 ? model.slice(0, at) : model;
  const fromId = at >= 0 ? model.slice(at + 1) : undefined;
  const clientOverride =
    (typeof body.model_variant === 'string' && body.model_variant.trim()) ||
    aliasFields.map((f) => (typeof body[f] === 'string' ? (body[f] as string).trim() : '')).find(Boolean) ||
    undefined;
  const variant = clientOverride ?? toolMeta?.modelVariant ?? fromId;
  return { tool, variant: variant || undefined };
}

/** Argumen utk logging — potong nilai panjang (base64, prompt). */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 60)}… (${v.length})` : v;
  }
  return out;
}
