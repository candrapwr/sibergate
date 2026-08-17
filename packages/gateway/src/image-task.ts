import type { Provider } from '@sibergate/core';

/**
 * Async image generation adapter for task-based image providers (Kling, vd2,
 *和一些 inference 平台).
 *
 * Beberapa provider image (mis. Kling AI) tidak langsung mengembalikan URL
 * gambar saat POST /v1/images/generations. Mereka mengembalikan task_id, dan
 * client harus poll endpoint GET /v1/images/generations/{task_id} sampai
 * task_status='succeed' utk mendapatkan URL gambar akhir.
 *
 * Modul ini menangani pipeline tsb supaya client OpenAI-compat tetap menerima
 * response format OpenAI (`{created, data:[{url}]}`) — gateway yg melakukan
 * polling di belakang. Hanya aktif utk provider async (response berisi
 * data.task_id); provider sync (DALL-E, dsb) langsung diteruskan verbatim.
 */

/** Konfigurasi polling. Default: 10x coba, jeda 5 detik. */
export const POLL_MAX_ITERATIONS = 50;
export const POLL_INTERVAL_MS = 5_000;

/** Status task yg dianggap sukses (case-insensitive). 'succeeded' = DashScope. */
const SUCCESS_STATUSES = new Set(['succeed', 'succeeded', 'success', 'completed', 'done']);
/** Status task yg dianggap masih berjalan. */
const PROCESSING_STATUSES = new Set(['processing', 'submitted', 'pending', 'running', 'queued']);
/** Status task yg dianggap gagal permanen. */
const FAILED_STATUSES = new Set(['failed', 'fail', 'failure', 'error', 'canceled', 'cancelled', 'rejected', 'timeout', 'expired']);

/**
 * Deteksi apakah response upstream adalah async task (perlu polling).
 * True bila body JSON punya field `data.task_id` (string non-kosong).
 */
export function isAsyncTaskResponse(body: unknown): body is { data: { task_id: string; task_status?: string } } {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  const data = obj.data;
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.task_id === 'string' && d.task_id.length > 0;
}

/**
 * Bangun URL polling GET dari endpoint image provider + task_id.
 * Contoh:
 *   provider.baseUrl = 'https://api.kling.com/v1'
 *   provider.endpoints.image = '/v1/images/generations'
 *   taskId = '908768099950788661'
 *   → GET https://api.kling.com/v1/images/generations/908768099950788661
 *
 * Handle baseUrl yg sudah menyertakan trailing /v1 — segmen /v1 di awal pollPath
 * di-drop supaya tidak dobel, sama dgn logika upstreamUrl() di provider.ts.
 */
export function buildPollUrl(provider: Provider, taskId: string): string {
  const imageEndpoint = provider.endpoints.image;
  if (!imageEndpoint) {
    throw new Error(`Provider ${provider.id} has no 'image' endpoint to build polling URL.`);
  }
  // Polling path = image endpoint + '/{task_id}'.
  const pollPath = imageEndpoint.endsWith('/')
    ? `${imageEndpoint}${taskId}`
    : `${imageEndpoint}/${taskId}`;

  // Resolve absolute URL (handle baseUrl + leading /v1 duplikat).
  if (/^https?:\/\//.test(pollPath)) return pollPath;
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (/(\/v\d+)$/.test(base) && pollPath.startsWith('/v1/')) {
    return `${base}${pollPath.slice(3)}`; // drop leading "/v1"
  }
  return `${base}${pollPath.startsWith('/') ? '' : '/'}${pollPath}`;
}

/** Status hasil polling. */
export type PollOutcome =
  | { status: 'succeed'; images: Array<{ url: string; revised_prompt?: string }> }
  | { status: 'failed'; message: string; taskStatus?: string };

/**
 * Poll GET {pollUrl} sampai task sukses atau habis retry. Setiap iterasi
 * menggunakan auth scheme provider (sama seperti adapter biasa).
 *
 * Strategi:
 *   - Berhenti saat `task_status` masuk SUCCESS_STATUSES → ambil
 *     `data.task_result.images[].url`.
 *   - Berhenti saat HTTP error (>= 400) atau `code != 0` dgn `message` error.
 *   - Bila status masih PROCESSING_STATUSES → lanjut iterasi.
 *   - Setelah POLL_MAX_ITERATIONS iterasi gagal → return failed.
 *
 * @param sleep injected utk kemudahan testing (default: real setTimeout).
 */
export async function pollTaskUntilDone(
  provider: Provider,
  pollUrl: string,
  opts: { maxIterations?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; dispatcher?: unknown } = {},
): Promise<PollOutcome> {
  const maxIterations = opts.maxIterations ?? POLL_MAX_ITERATIONS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < maxIterations; i++) {
    if (opts.signal?.aborted) {
      return { status: 'failed', message: 'Request aborted by client.' };
    }
    await sleep(intervalMs);

    const headers = buildAuthHeaders(provider);
    let res: Response;
    try {
      res = await fetch(pollUrl, { method: 'GET', headers, signal: opts.signal, ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) });
    } catch (err) {
      const e = err as Error;
      return { status: 'failed', message: `Failed to reach ${provider.id} (poll iteration ${i + 1}): ${e.message}` };
    }

    if (!res.ok) {
      // HTTP error — termasuk "Task not found" (contoh code 1201). Berhenti.
      let detail = '';
      try {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const errBody = (await res.clone().json()) as { message?: string; error?: { message?: string } | string };
          detail = typeof errBody.message === 'string' ? errBody.message : '';
        } else {
          detail = (await res.clone().text()).slice(0, 200);
        }
      } catch {
        /* ignore */
      }
      return { status: 'failed', message: `${provider.id} polling returned ${res.status}${detail ? `: ${detail}` : ''}` };
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      return { status: 'failed', message: `${provider.id} polling returned non-JSON body.` };
    }

    const taskStatus = String(body?.data?.task_status ?? '').toLowerCase();
    const code = body?.code;
    const message = typeof body?.message === 'string' ? body.message : '';
    const taskStatusMsg = typeof body?.data?.task_status_msg === 'string' ? body.data.task_status_msg : '';

    // Bila code != 0 dan ada message error → anggap gagal.
    if (typeof code === 'number' && code !== 0) {
      return { status: 'failed', message: taskStatusMsg || message || `Task failed (code ${code}).`, taskStatus };
    }

    if (FAILED_STATUSES.has(taskStatus)) {
      return { status: 'failed', message: taskStatusMsg || message || `Task failed with status '${taskStatus}'.`, taskStatus };
    }

    if (SUCCESS_STATUSES.has(taskStatus)) {
      // Ekstrak images dari task_result.images[].url.
      const images = Array.isArray(body?.data?.task_result?.images)
        ? (body.data.task_result.images as any[])
            .filter((img) => img && typeof img.url === 'string')
            .map((img) => {
              const out: { url: string; revised_prompt?: string } = { url: img.url };
              if (typeof img.revised_prompt === 'string') out.revised_prompt = img.revised_prompt;
              return out;
            })
        : [];
      if (images.length === 0) {
        return { status: 'failed', message: 'Task succeeded but no image URLs found.', taskStatus };
      }
      return { status: 'succeed', images };
    }

    // Status masih processing/queued/submitted → lanjut iterasi berikutnya.
    if (PROCESSING_STATUSES.has(taskStatus)) continue;
    // Bila status tidak dikenal, juga lanjut (lebih permisif daripada gagal).
  }

  return { status: 'failed', message: `Task did not complete within ${maxIterations} polling iterations (${Math.round((maxIterations * intervalMs) / 1000)}s).` };
}

/** Build auth headers sesuai scheme provider (di-reuse dari sendUpstream). */
function buildAuthHeaders(provider: Provider): Record<string, string> {
  const headers: Record<string, string> = { ...provider.headers };
  if (!provider.apiKey || provider.authScheme === 'none') return headers;
  switch (provider.authScheme) {
    case 'x-api-key':
      headers['x-api-key'] = provider.apiKey;
      break;
    case 'basic': {
      const raw = provider.apiKey.includes(':') ? provider.apiKey : `:${provider.apiKey}`;
      headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
      break;
    }
    case 'bearer':
    default:
      headers.Authorization = `Bearer ${provider.apiKey}`;
      break;
    // Catatan: 'query' scheme butuh URL rewrite — di-handle di pemanggil bila
    // diperlukan (jarang utk polling image).
  }
  return headers;
}

/**
 * Bangun response OpenAI-compat image dari daftar image URL hasil polling.
 * Format: { created, data: [{ url, revised_prompt? }] }.
 */
export function buildOpenAIImageResponse(
  images: Array<{ url: string; revised_prompt?: string }>,
  created: number = Math.floor(Date.now() / 1000),
): { created: number; data: Array<{ url: string; revised_prompt?: string }> } {
  return {
    created,
    data: images.map((img) => {
      const out: { url: string; revised_prompt?: string } = { url: img.url };
      if (img.revised_prompt) out.revised_prompt = img.revised_prompt;
      return out;
    }),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * DashScope (Qwen-Image / Alibaba-hosted Kling) — task async + sync.
 *
 * Bentuk DashScope BERBEDA dgn Kling langsung:
 *   - Submit async  : { output: { task_id, task_status }, request_id }
 *                     (task_id di OUTPUT, bukan data.task_id — deteksi
 *                     isAsyncTaskResponse tidak match).
 *   - Query task    : GET {origin}/api/v1/tasks/{task_id}  ← URL generik,
 *                     BUKAN {image_endpoint}/{task_id}.
 *   - Hasil akhir   : { output: { task_status, choices: [{ message: { content:
 *     [{ image: url }] } }] }, usage }  ← format 'multimodal', sama dgn
 *     Qwen-Image synchronous.
 *   - Sync (Qwen)   : response langsung berbentuk output.choices[...] tanpa
 *     task_id sama sekali.
 *
 * Semua jalur di bawah aktif HANYA utk route target dgn mapping='auto';
 * mode verbatim tetap memakai jalur Kling lama di atas (backward compat).
 * ══════════════════════════════════════════════════════════════════════ */

/** Deteksi response async task gaya DashScope: output.task_id terisi. */
export function isDashScopeTaskResponse(body: unknown): body is { output: { task_id: string; task_status?: string }; code?: string; message?: string } {
  if (!body || typeof body !== 'object') return false;
  const out = (body as Record<string, unknown>).output;
  if (!out || typeof out !== 'object') return false;
  const o = out as Record<string, unknown>;
  return typeof o.task_id === 'string' && o.task_id.length > 0;
}

/** Deteksi response image gaya DashScope synchronous (output.choices, tanpa task). */
export function isDashScopeImageBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const out = (body as Record<string, unknown>).output;
  if (!out || typeof out !== 'object') return false;
  return Array.isArray((out as Record<string, unknown>).choices);
}

/**
 * Bangun URL polling task DashScope: {origin}/api/v1/tasks/{task_id}.
 * Endpoint task bersifat generik per-host (bukan turunan endpoint image),
 * jadi cukup ambil origin dari baseUrl provider.
 */
export function buildDashScopePollUrl(provider: Provider, taskId: string): string {
  try {
    const origin = new URL(provider.baseUrl).origin;
    return `${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  } catch {
    // baseUrl aneh (relatif dsb) — fallback best-effort concat.
    return `${provider.baseUrl.replace(/\/+$/, '')}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  }
}

/**
 * Ekstrak URL gambar dari output DashScope (task final maupun sync).
 * Mendukung dua varian output:
 *   - choices[].message.content[] : [{image: url}] (multimodal — Qwen-Image,
 *     Kling via Model Studio). Content entry bisa object {image} atau string.
 *   - results[] : [{url}] (image-synthesis async lama, qwen-image-plus).
 */
function extractDashScopeImages(output: unknown): Array<{ url: string; revised_prompt?: string }> {
  if (!output || typeof output !== 'object') return [];
  const o = output as Record<string, unknown>;
  const urls: Array<{ url: string; revised_prompt?: string }> = [];
  if (Array.isArray(o.choices)) {
    for (const choice of o.choices as any[]) {
      const content = choice?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part === 'string' && part) urls.push({ url: part });
        else if (part && typeof part === 'object' && typeof part.image === 'string' && part.image) {
          urls.push({ url: part.image });
        }
      }
    }
  }
  if (urls.length === 0 && Array.isArray(o.results)) {
    for (const r of o.results as any[]) {
      if (r && typeof r.url === 'string' && r.url) urls.push({ url: r.url });
    }
  }
  return urls;
}

/** Convert response image DashScope (synchronous) → format OpenAI. */
export function convertDashScopeImageBody(body: Record<string, unknown>): { created: number; data: Array<{ url: string }> } | null {
  const images = extractDashScopeImages(body.output);
  if (images.length === 0) return null;
  return buildOpenAIImageResponse(images) as { created: number; data: Array<{ url: string }> };
}

/**
 * Poll task DashScope sampai selesai. Status di output.task_status
 * (PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN — UNKNOWN diperlakukan
 * permisif: lanjut polling). Error DashScope datang sebagai {code, message}
 * top-level (bukan data.task_status_msg).
 */
export async function pollDashScopeTaskUntilDone(
  provider: Provider,
  pollUrl: string,
  opts: { maxIterations?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; dispatcher?: unknown } = {},
): Promise<PollOutcome> {
  const maxIterations = opts.maxIterations ?? POLL_MAX_ITERATIONS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < maxIterations; i++) {
    if (opts.signal?.aborted) {
      return { status: 'failed', message: 'Request aborted by client.' };
    }
    await sleep(intervalMs);

    const headers = buildAuthHeaders(provider);
    let res: Response;
    try {
      res = await fetch(pollUrl, { method: 'GET', headers, signal: opts.signal, ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) });
    } catch (err) {
      return { status: 'failed', message: `Failed to reach ${provider.id} (poll iteration ${i + 1}): ${(err as Error).message}` };
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.clone().text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      return { status: 'failed', message: `${provider.id} task polling returned ${res.status}${detail ? `: ${detail}` : ''}` };
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      return { status: 'failed', message: `${provider.id} task polling returned non-JSON body.` };
    }

    const taskStatus = String(body?.output?.task_status ?? '').toLowerCase();
    const message = typeof body?.message === 'string' ? body.message : '';

    // Error DashScope: top-level {code, message} (mis. InvalidApiKey).
    if (typeof body?.code === 'string' && body.code) {
      return { status: 'failed', message: message || `Task failed (code ${body.code}).`, taskStatus };
    }

    if (FAILED_STATUSES.has(taskStatus)) {
      return { status: 'failed', message: message || `Task failed with status '${taskStatus}'.`, taskStatus };
    }

    if (SUCCESS_STATUSES.has(taskStatus)) {
      const images = extractDashScopeImages(body?.output);
      if (images.length === 0) {
        return { status: 'failed', message: 'Task succeeded but no image URLs found.', taskStatus };
      }
      return { status: 'succeed', images };
    }

    // PENDING / RUNNING / UNKNOWN → lanjut iterasi.
  }

  return { status: 'failed', message: `Task did not complete within ${maxIterations} polling iterations (${Math.round((maxIterations * intervalMs) / 1000)}s).` };
}
