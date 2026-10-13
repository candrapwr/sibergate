import type { McpToolResult } from './client.js';

/**
 * Normalisasi hasil tools/call MCP.
 *
 * Tool MCP sangat beragam bentuknya; modul ini mengekstrak pola umum yang
 * dipakai adapter image/video dan endpoint generik:
 *   - task ref async (generation_id Kling / task_id umum)
 *   - status task (submitted|processing|succeed|failed|... → queued|in_progress|
 *     completed|failed ala OpenAI)
 *   - URL aset (gambar/video/lainnya) dari content blocks maupun JSON di dalam
 *     text/structuredContent (mis. works[].url milik Kling)
 */

export interface NormalizedToolCall {
  tool: string;
  isError: boolean;
  /** Gabungan semua content bertipe text. */
  text: string;
  /** Content blocks mentah (type text|image|audio|resource|resource_link). */
  content: Array<Record<string, unknown>>;
  /** structuredContent bila server mengirimkannya. */
  structured?: unknown;
  /** Task ref async (generation_id/task_id); null bila hasil sinkron. */
  taskRef: string | null;
  /** Status mentah task (submitted/processing/succeed/...) bila terdeteksi. */
  taskStatus: string | null;
  /** Status ternormalisasi ala OpenAI (queued|in_progress|completed|failed). */
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | null;
  /** Progress 0-100 bila server melaporkannya (video generation). */
  progress: number | null;
  /** URL/URI gambar (http(s):// atau data:image/...). */
  imageUrls: string[];
  /** URL video. */
  videoUrls: string[];
  /** URL lain (audio, file, halaman). */
  otherUrls: string[];
}

const TASK_REF_KEYS = /^(generation_?id|task_?id|taskid|job_?id|request_?id)$/i;
const TASK_STATUS_KEYS = /^(task_?status|generation_?status|status|state)$/i;
const TASK_PROGRESS_KEYS = /^(progress|percent|completion_?percent(age)?)$/i;

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)([?#].*)?$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv|m4v|m3u8)([?#].*)?$/i;

export function normalizeToolCall(tool: string, result: McpToolResult): NormalizedToolCall {
  const text = result.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');

  const out: NormalizedToolCall = {
    tool,
    isError: !!result.isError,
    text,
    content: result.content,
    structured: result.structuredContent,
    taskRef: null,
    taskStatus: null,
    status: null,
    progress: null,
    imageUrls: [],
    videoUrls: [],
    otherUrls: [],
  };

  // 1. URL dari content blocks (image/audio/resource/resource_link).
  for (const block of result.content) {
    const dataUri = typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? `data:${block.mimeType};base64,${block.data}`
      : null;
    const resourceUri =
      block.type === 'resource' && block.resource && typeof block.resource === 'object'
        ? (block.resource as { uri?: unknown }).uri
        : (block as { uri?: unknown }).uri;
    const candidate = typeof resourceUri === 'string' ? resourceUri : dataUri;
    if (candidate) classifyUrl(candidate, out);
  }

  // 2. Deep-scan structuredContent + text (bisa JSON) utk task ref/status/URL.
  const roots: unknown[] = [result.structuredContent];
  if (text) {
    const parsed = tryParseJson(text);
    if (parsed !== undefined) roots.push(parsed);
  }
  for (const block of result.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const parsed = tryParseJson(block.text);
    if (parsed !== undefined) roots.push(parsed);
  }
  const seen = new Set<unknown>();
  for (const root of roots) {
    if (root) deepScan(root, out, seen, 0);
  }

  // 3. URL mentah di dalam text (termasuk yang terbungkus JSON string) —
  // regex global; dedupe sudah ditangani classifyUrl.
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    classifyUrl(match[0], out);
  }

  if (out.taskStatus) out.status = mapTaskStatus(out.taskStatus);
  return out;
}

/** Map status vendor ke status OpenAI-style. Unknown → in_progress. */
export function mapTaskStatus(raw: string): 'queued' | 'in_progress' | 'completed' | 'failed' {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (/(succeed|success|completed|complete|done|finished|ready)/.test(s)) return 'completed';
  if (/(fail|failed|failure|error|canceled|cancelled|expired)/.test(s)) return 'failed';
  if (/(submit|pending|queued|created|waiting)/.test(s)) return 'queued';
  return 'in_progress';
}

function classifyUrl(url: string, out: NormalizedToolCall): void {
  if (out.imageUrls.includes(url) || out.videoUrls.includes(url) || out.otherUrls.includes(url)) return;
  if (url.startsWith('data:image/')) out.imageUrls.push(url);
  else if (url.startsWith('data:video/')) out.videoUrls.push(url);
  else if (IMAGE_EXT.test(url)) out.imageUrls.push(url);
  else if (VIDEO_EXT.test(url)) out.videoUrls.push(url);
  else if (/^https?:\/\//.test(url)) out.otherUrls.push(url);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Deep-scan object/array utk key task-ref/status + nilai string URL. */
function deepScan(node: unknown, out: NormalizedToolCall, seen: Set<unknown>, depth: number): void {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    // String pendek yang persis task id biasanya sudah ditangani via key-nya.
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') deepScan(item, out, seen, depth + 1);
      else if (typeof item === 'string' && /^https?:\/\//.test(item)) classifyUrl(item, out);
    }
    return;
  }
  if (typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      if (!out.taskRef && TASK_REF_KEYS.test(key) && value) out.taskRef = value;
      else if (!out.taskStatus && TASK_STATUS_KEYS.test(key) && value) out.taskStatus = value;
      else if (/^https?:\/\//.test(value) || value.startsWith('data:image/') || value.startsWith('data:video/')) {
        classifyUrl(value, out);
      } else if (looksLikeUrlKey(key) && isUrlIsh(value)) {
        // Key URL eksplisit (url, image_url, cover, ...) — classify meski
        // ekstensi file tidak dikenal (URL CDN tanpa ekstensi).
        classifyUrl(value, out);
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      if (out.progress === null && TASK_PROGRESS_KEYS.test(key)) {
        // Normalisasi ke 0-100 (beberapa API memakai 0-1).
        out.progress = value <= 1 ? Math.round(value * 100) : Math.round(Math.min(100, Math.max(0, value)));
      }
    } else if (value && typeof value === 'object') {
      deepScan(value, out, seen, depth + 1);
    }
  }
}

/** Key yang nilainya diketahui sebuah URL (walau tanpa ekstensi file). */
function looksLikeUrlKey(key: string): boolean {
  return /^(url|image_?url|video_?url|audio_?url|file_?url|download_?url|result_?url|cover|thumbnail)$/i.test(key);
}

/** Nilai yang terlihat seperti URL host/path (ada titik domain, tanpa spasi). */
function isUrlIsh(value: string): boolean {
  return !/\s/.test(value) && /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(value);
}

/**
 * Deteksi tool polling dari daftar tool hasil sync (heuristik nama + schema).
 * Kling: `query_tasks` (arg generation_id). Umum: query_task/get_task_result.
 */
export function detectPollTool(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): string | null {
  const candidates = tools.filter((t) =>
    /(query_?tasks?|get_?task|task_?query|task_?status|query_?generation|get_?result)/i.test(t.name),
  );
  if (!candidates.length) return null;
  // Prioritaskan yang punya argumen task-id-ish di schema-nya.
  const withTaskArg = candidates.find((t) => {
    const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>;
    return Object.keys(props).some((k) => TASK_REF_KEYS.test(k));
  });
  return (withTaskArg ?? candidates[0])!.name;
}

/** Nama argumen task-id dari inputSchema tool polling. */
export function detectPollToolArg(tool: { inputSchema?: Record<string, unknown> } | undefined): string {
  const props = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const found = Object.keys(props).find((k) => TASK_REF_KEYS.test(k));
  return found ?? 'task_id';
}

/**
 * Tebak modalitas model dari NAMA tool (utk import tools→models).
 *
 * Klasifikasi generasi (image/video) didasarkan NAMA saja — deskripsi terlalu
 * berisiko false positive (mis. element_create: "from a set of images or a
 * video" padahal bukan tool generasi). Hanya tool generasi yang menjadi model
 * saat sync; tool lain (who_am_i, query_tasks, element_*, dll.) = utilitas,
 * dijalankan lewat panel "Run tool" di UI admin / endpoint generik.
 */
export function guessToolModalities(name: string, _description = ''): string[] {
  const n = name.toLowerCase();
  // ── generasi video ──
  if (/(text|image|img)[_-]?to[_-]?video/.test(n)) return ['video-generation'];
  if (/(video[_-]?(gen|generate|generation|create|synthesis)|[_-]t2v|^t2v)/.test(n)) return ['video-generation'];
  if (/(motion[_-]?(control|transfer)|animate|lip[_-]?sync)/.test(n)) return ['video-generation'];
  // video-to-video / reference-video (Kling: omni_ref_video).
  if (/(_ref_?video|ref_?video|video_?ref|v2v)/.test(n)) return ['video-generation'];
  // ── generasi image ──
  if (/(text|image|img)[_-]?to[_-]?(image|img)/.test(n)) return ['image-generation'];
  if (/(image[_-]?(gen|generate|generation|create|synthesis)|img2img|inpaint|outpaint|upscale|[_-]t2i|^t2i)/.test(n)) return ['image-generation'];
  if (/(photo|picture|draw|paint)[_-]?(gen|generate|create)?/.test(n)) return ['image-generation'];
  // ── bukan generasi → utilitas ──
  return ['api'];
}

/**
 * True bila tool adalah tool GENERASI (image/video) — pantas jadi model &
 * target route saat sync. Tool utilitas (query, element, upload, who_am_i)
 * TIDAK di-import sebagai model.
 */
export function isGenerationTool(name: string, description = ''): boolean {
  const modalities = guessToolModalities(name, description);
  return modalities.some((m) => m === 'image-generation' || m === 'video-generation');
}

/* ─────────────────── who_am_i → referensi model (Kling) ───────────────────
 * Server MCP Kling TIDAK mendeklarasikan daftar model di inputSchema
 * tools/list — parameter `model` bahkan WAJIB dan daftarnya hanya ada di
 * hasil who_am_i: { availableModels: { <tool>: { defaultModel, models: [{
 * model, alias, description, arguments[], inputs[] }] } } }. Parser di sini
 * mengubah bentuk itu jadi spesifikasi per-tool + synthetic JSON Schema per
 * model utk dipakai schema-map saat dispatch.
 */

export interface WhoAmIModelSpec {
  model: string;
  alias?: string;
  description?: string;
  /** Argumen generik per model (prompt, duration, aspect_ratio, ...). */
  arguments?: Array<Record<string, unknown>>;
  /** Input media per model (image_1, first_image, video_1, ...). */
  inputs?: Array<Record<string, unknown>>;
}

export interface WhoAmIToolSpec {
  tool: string;
  defaultModel?: string;
  models: WhoAmIModelSpec[];
}

/**
 * Parse hasil who_am_i → spesifikasi tool generasi. Menerima object hasil
 * parse JSON (field `availableModels`) atau nilai mentah; return [] bila
 * bentuk tidak dikenali (server MCP lain / gagal).
 */
export function parseWhoAmIToolModels(payload: unknown): WhoAmIToolSpec[] {
  const root = payload as { availableModels?: Record<string, unknown> } | undefined | null;
  const available = root?.availableModels;
  if (!available || typeof available !== 'object') return [];
  const specs: WhoAmIToolSpec[] = [];
  for (const [tool, rawSpec] of Object.entries(available)) {
    if (!rawSpec || typeof rawSpec !== 'object') continue;
    const spec = rawSpec as { defaultModel?: unknown; models?: unknown };
    const models: WhoAmIModelSpec[] = [];
    if (Array.isArray(spec.models)) {
      for (const raw of spec.models) {
        if (!raw || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        if (typeof m.model === 'string' && m.model) {
          models.push({
            model: m.model,
            alias: typeof m.alias === 'string' ? m.alias : undefined,
            description: typeof m.description === 'string' ? m.description : undefined,
            arguments: Array.isArray(m.arguments) ? (m.arguments as Array<Record<string, unknown>>) : undefined,
            inputs: Array.isArray(m.inputs) ? (m.inputs as Array<Record<string, unknown>>) : undefined,
          });
        }
      }
    }
    if (!models.length) continue;
    specs.push({
      tool,
      defaultModel: typeof spec.defaultModel === 'string' ? spec.defaultModel : undefined,
      models,
    });
  }
  return specs;
}

/**
 * Hasil uraian parameter sebuah model who_am_i.
 *  - schema : JSON Schema sintetis dari arguments[] (flat) — dipakai schema-map.
 *  - inputSlots : nama slot media (image_1, first_image, dst.) TERPISAH dari
 *    schema (utk envelope pairs dikirim via array `inputs`, bukan properti).
 */
export interface ModelParamSpec {
  schema: Record<string, unknown>;
  inputSlots: string[];
}

/**
 * Uraikan arguments[]/inputs[] model who_am_i → schema sintetis + slot media.
 *
 * Properti `model` SELALU di-inject ke schema (enum = semua model tool) karena
 * server Kling mewajibkannya, walau tidak dicantumkan di arguments[] per model.
 */
export function buildModelParams(toolModels: string[], spec: WhoAmIModelSpec): ModelParamSpec {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const inputSlots: string[] = [];
  for (const raw of spec.arguments ?? []) {
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name || name in properties) continue;
    const allowed = Array.isArray(raw.allowedValues) ? raw.allowedValues.filter((v) => typeof v === 'string') : [];
    const def = raw.default;
    properties[name] = {
      type: allowed.length || typeof def === 'string' ? 'string' : typeof def === 'number' ? 'number' : 'string',
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(allowed.length ? { enum: allowed } : {}),
    };
    if (raw.required === true) required.push(name);
  }
  for (const raw of spec.inputs ?? []) {
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (name && !inputSlots.includes(name)) inputSlots.push(name);
  }
  // Urutkan slot media: first_image < subject_image_N < image_N < video_1.
  inputSlots.sort((a, b) => mediaSlotOrder(a) - mediaSlotOrder(b));
  if (toolModels.length) {
    properties.model = { type: 'string', enum: toolModels, description: 'Model variant (required by server)' };
    required.push('model');
  }
  return {
    schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    inputSlots,
  };
}

/** Deteksi envelope pemanggilan tools/call dari schema tools/list ASLI. */
export type ArgEnvelope = 'flat' | 'pairs';

/**
 * Kling memakai envelope 'pairs': properti top-level `model` + `arguments`
 * sebagai array pasangan {name, value} + `inputs` array {name, inputType, url}.
 * Server lain umumnya 'flat' (argumen = properti langsung).
 */
export function detectArgEnvelope(rawSchema: Record<string, unknown> | undefined): ArgEnvelope {
  const props = (rawSchema?.properties ?? {}) as Record<string, any>;
  const argsProp = props.arguments;
  const items = argsProp && typeof argsProp === 'object' ? argsProp.items : undefined;
  const itemRequired = Array.isArray(items?.required) ? items.required : [];
  return argsProp?.type === 'array' && itemRequired.includes('name') && itemRequired.includes('value')
    ? 'pairs'
    : 'flat';
}

/** Urutan slot media utk pengisian berurutan. */
export function mediaSlotOrder(name: string): number {
  if (/^first_image$/.test(name)) return 0;
  const m = name.match(/^(subject_image|image|video|tail_image)_(\d+)$/);
  if (!m) return 50;
  const group = m[1] === 'subject_image' ? 0 : m[1] === 'image' ? 10 : m[1] === 'tail_image' ? 30 : 20;
  return group + Number(m[2]);
}
