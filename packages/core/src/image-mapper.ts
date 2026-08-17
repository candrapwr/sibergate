/**
 * Image generation input mapping — translate a client's OpenAI-style
 * /v1/images/generations body into the TARGET provider's native request
 * format before the request is sent upstream. Image-side analogue of
 * reasoning-mapper.ts; aktif HANYA untuk route target dgn mapping='auto'
 * (default route target adalah 'verbatim' — body diteruskan apa adanya).
 *
 * Kenapa perlu: tiap vendor image gen punya bentuk request berbeda total:
 *   - OpenAI          : {model, prompt, n, size, quality, ...} (JSON).
 *                       Editing dgn gambar referensi TIDAK ada di endpoint
 *                       ini — hidup terpisah di /v1/images/edits (multipart).
 *   - Kling AI        : {model_name, prompt, negative_prompt, image,
 *                       aspect_ratio, n, ...} (JSON, async task).
 *   - Qwen-Image      : {model, input:{messages:[{content:[{image},{text}]}]},
 *                       parameters:{negative_prompt, size:"W*H", n, ...}}
 *                       (JSON, DashScope multimodal-generation).
 *
 * Pivot / bentuk kanonik = OpenAI Images SUPERSET: field standar OpenAI
 * plus field non-standar yg diberkati sebagai warga kelas satu supaya
 * fitur vendor tidak hilang di tengah jalan: negative_prompt, image
 * (string/array, URL atau base64/data-URL), mask, seed, prompt_extend,
 * watermark, image_fidelity, resolution ('1k'|'2k'|'4k' — dialek Kling v3;
 * di-bridge dari quality utk target Kling, lihat emitKling).
 *
 * Dua prinsip kerja (selaras filosofi mapping SiberGate):
 *   1. TWO-WAY parse — client boleh kirim dialek mana pun (OpenAI `model`
 *      + `size:"1024x1536"`, atau gaya Kling `model_name` + `aspect_ratio`),
 *      semua dinormalisasi dulu ke intent kanonik, baru di-emit ke dialek
 *      target. Route itu masked & failover bisa pindah vendor, jadi intent
 *      harus lepas dari dialek asal.
 *   2. "Map what exists, drop what has no equivalent, never invent" —
 *      field yg tidak dikirim client TIDAK dikarang; default provider
 *      upstream yg berlaku. Field struktural (image) tidak pernah
 *      di-drop diam-diam: utk target OpenAI ia memicu redirect ke
 *      /v1/images/edits (multipart), bukan dibuang.
 *
 * Mapper ini STRUKTURAL, bukan semantik: tidak ada pengetahuan "model seri X
 * bisa gambar atau tidak". Kalau model ternyata tidak mendukung, upstream
 * yg menolak dgn pesan aslinya (→ GatewayCallError → failover jalan).
 *
 * SIZE: daripada snap resolusi arbitrer ke daftar valid tiap model family
 * (beda-beda per vendor, rawan basi), size dinormalisasi ke 3 KELAS rasio
 * yg pasti didukung semua target: square / landscape / portrait. Tiap
 * dialek emit resolusi kanonik aman utk kelas tsb.
 */

import type { Provider } from './types.js';

/** Tiga kelas rasio aman — irisan semua provider image yang didukung. */
export type ImageSizeClass = 'square' | 'landscape' | 'portrait';

/** Hasil mapping: JSON native, atau instruksi redirect ke OpenAI /edits. */
export type MappedImageRequest =
  | { kind: 'json'; body: Record<string, unknown> }
  | {
    kind: 'edits';
    /** String fields utk FormData (prompt, model, n, size, …). */
    fields: Record<string, string>;
    /** Gambar referensi (URL / data-URL / base64 mentah) → file part 'image'. */
    images: string[];
    /** Mask opsional (URL / data-URL / base64) → file part 'mask'. */
    mask?: string;
  };

/** Intent kanonik hasil parse two-way dari body client. */
interface CanonicalImageIntent {
  prompt?: string;
  negativePrompt?: string;
  images: string[];
  mask?: string;
  n?: number;
  sizeClass?: ImageSizeClass;
  /**
   * Knob fidelity/resolusi. Dua dialek utk konsep yg beririsan:
   *   - quality (OpenAI): 'low'|'medium'|'high'|'auto' (gpt-image), 'hd'|'standard' (dall-e-3)
   *   - resolution (Kling v3): '1k'|'2k'|'4k'
   * Dijaga TERPISAH (bukan satu konsep) karena sumbunya berbeda: quality =
   * effort render, resolution = piksel. Hanya di-bridge satu arah utk Kling
   * (quality→resolution) saat resolution tidak eksplisit — pola sama seperti
   * mapReasoning (effort high → budget_tokens 16384 utk Claude 3.7).
   */
  quality?: string;
  resolution?: '1k' | '2k' | '4k';
  seed?: number;
  promptExtend?: boolean;
  /** qwen-image-3.0 saja: 'direct' (default) | 'agent'. */
  promptExtendMode?: string;
  /** Wan 2.7 exclusive: coherent image sets (n up to 12). */
  enableSequential?: boolean;
  /** Wan 2.7 exclusive: enhanced reasoning. */
  thinkingMode?: boolean;
  /** Wan 2.7 exclusive: 3–10 warna {hex, ratio} utk color control. */
  colorPalette?: unknown[];
  /** Wan 2.6-image exclusive: interleaved mode image count 1–5. */
  maxImages?: number;
  /** Wan 2.6-image exclusive: interleaved mode (memaksa n=1). */
  enableInterleave?: boolean;
  watermark?: boolean;
  imageFidelity?: number;
  /** Native passthrough Kling (callback utk async task). */
  callbackUrl?: string;
  externalTaskId?: string;
  /** Field native OpenAI yg diteruskan apa adanya utk dialek openai. */
  openaiExtras: Record<string, unknown>;
}

/* ─────────────────────── two-way parse (masuk) ─────────────────────── */

/**
 * Klasifikasi size/aspect_ratio client ke 3 kelas rasio. Menerima:
 *   - size OpenAI style   : "1024x1024", "2048*2048" (x atau *), "auto" → null
 *   - aspect_ratio Kling  : "16:9", "4:3", "1:1", "9:16", …
 * Return null bila client tidak mengekspresikan size sama sekali (→ default
 * provider yg berlaku — never invent).
 */
export function parseImageSizeClass(body: Record<string, unknown>): ImageSizeClass | null {
  const size = typeof body.size === 'string' ? body.size.trim() : '';
  if (size && size.toLowerCase() !== 'auto') {
    const m = size.match(/^(\d+)[x*](\d+)$/i);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > h) return 'landscape';
      if (h > w) return 'portrait';
      return 'square';
    }
    // size tak dikenali bentuknya → abaikan (jangan tebak).
  }
  const ar = typeof body.aspect_ratio === 'string' ? body.aspect_ratio.trim() : '';
  if (ar) {
    const m = ar.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > h) return 'landscape';
      if (h > w) return 'portrait';
      return 'square';
    }
  }
  return null;
}

/** Normalisasi field image: terima string, atau array of string. */
function parseImages(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  return [];
}

/** Field native OpenAI generations/edits yg boleh diteruskan utk dialek openai. */
const OPENAI_PASSTHROUGH = [
  'quality', 'style', 'response_format', 'background', 'output_format',
  'output_compression', 'moderation', 'user', 'input_fidelity',
] as const;

/** Parse body client (dialek apa pun) → intent kanonik. Pure. */
function parseIntent(body: Record<string, unknown>): CanonicalImageIntent {
  const intent: CanonicalImageIntent = { images: [], openaiExtras: {} };
  if (typeof body.prompt === 'string' && body.prompt.trim()) intent.prompt = body.prompt;
  if (typeof body.negative_prompt === 'string' && body.negative_prompt.trim()) intent.negativePrompt = body.negative_prompt;
  // Dialek Kling menyebut ref image 'image' juga — satu nama, dua dialek, satu makna.
  intent.images = parseImages(body.image);
  if (typeof body.mask === 'string' && body.mask.trim()) intent.mask = body.mask.trim();
  if (typeof body.n === 'number' && Number.isFinite(body.n)) intent.n = Math.trunc(body.n);
  const cls = parseImageSizeClass(body);
  if (cls) intent.sizeClass = cls;
  if (typeof body.quality === 'string' && body.quality.trim()) intent.quality = body.quality.trim();
  // resolution dialek Kling ('1k'|'2k'|'4k'). Nilai tak dikenal → diabaikan
  // (jangan ditebak; upstream-lah yg memvalidasi nilai valid).
  if (typeof body.resolution === 'string') {
    const r = body.resolution.trim().toLowerCase();
    if (r === '1k' || r === '2k' || r === '4k') intent.resolution = r;
  }
  if (typeof body.seed === 'number' && Number.isFinite(body.seed)) intent.seed = Math.trunc(body.seed);
  if (typeof body.prompt_extend === 'boolean') intent.promptExtend = body.prompt_extend;
  if (typeof body.prompt_extend_mode === 'string' && body.prompt_extend_mode.trim()) intent.promptExtendMode = body.prompt_extend_mode.trim();
  if (typeof body.enable_sequential === 'boolean') intent.enableSequential = body.enable_sequential;
  if (typeof body.thinking_mode === 'boolean') intent.thinkingMode = body.thinking_mode;
  if (Array.isArray(body.color_palette)) intent.colorPalette = body.color_palette;
  if (typeof body.max_images === 'number' && Number.isFinite(body.max_images)) intent.maxImages = Math.trunc(body.max_images);
  if (typeof body.enable_interleave === 'boolean') intent.enableInterleave = body.enable_interleave;
  if (typeof body.watermark === 'boolean') intent.watermark = body.watermark;
  if (typeof body.image_fidelity === 'number' && Number.isFinite(body.image_fidelity)) intent.imageFidelity = body.image_fidelity;
  if (typeof body.callback_url === 'string' && body.callback_url.trim()) intent.callbackUrl = body.callback_url.trim();
  if (typeof body.external_task_id === 'string' && body.external_task_id.trim()) intent.externalTaskId = body.external_task_id.trim();
  for (const f of OPENAI_PASSTHROUGH) {
    if (body[f] !== undefined) intent.openaiExtras[f] = body[f];
  }
  return intent;
}

/* ─────────────────── deteksi dialek target (per provider) ─────────────────── */

export type ImageDialect = 'kling' | 'qwen' | 'openai';

/** Strip path prefix host inference ('novita/qwen/qwen-image' → 'qwen-image'). */
function bareModel(model: string): string {
  const i = model.lastIndexOf('/');
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

/**
 * Deteksi dialek request image target. Prioritas: provider id (paling
 * reliable — route target menunjuk vendor asli), lalu baseUrl (Kling host),
 * lalu family model (fallback utk inference host yg menyajikan model
 * vendor lain). Unknown → 'openai' (dialeg OpenAI-compat, default aman).
 */
export function detectImageDialect(provider: Pick<Provider, 'id' | 'baseUrl'>, model: string): ImageDialect {
  const pid = provider.id.toLowerCase();
  if (pid === 'kling' || pid === 'klingai') return 'kling';
  if (pid === 'qwen' || pid === 'qwencloud' || pid === 'dashscope' || pid === 'alibaba' || pid === 'aliyun') return 'qwen';
  if (/klingai/i.test(provider.baseUrl)) return 'kling';
  if (/dashscope|aliyuncs/i.test(provider.baseUrl)) return 'qwen';
  const m = bareModel(model);
  if (/^kling[-_]/i.test(m)) return 'kling';
  if (/^qwen-image/i.test(m)) return 'qwen';
  // Wan family (wan2.7-image-pro, wan2.6-t2i, wan2.5, …) — envelope DashScope
  // sama (multimodal-generation / image-synthesis), params beda (lihat emitQwen).
  if (/^wan[-_]?2|^wanx/i.test(m)) return 'qwen';
  return 'openai';
}

/* ───────────────────── tabel size 3-kelas per dialek ───────────────────── */

const KLING_ASPECT: Record<ImageSizeClass, string> = {
  square: '1:1',
  landscape: '16:9',
  portrait: '9:16',
};

/** Qwen-Image 2.0/3.0-series (range 512²–2048² total, preset 16:9/9:16/1:1). */
const QWEN_SIZE_20: Record<ImageSizeClass, string> = {
  square: '2048*2048',
  landscape: '2688*1536',
  portrait: '1536*2688',
};

/** Qwen-Image max/plus/awal (qwen-image-max, qwen-image-plus, qwen-image). */
const QWEN_SIZE_MAX: Record<ImageSizeClass, string> = {
  square: '1328*1328',
  landscape: '1664*928',
  portrait: '928*1664',
};

/** Wan 2.7 (per sisi 768–4096; juga menerima shorthand "1K"/"2K"/"4K"). */
const WAN27_SIZE: Record<ImageSizeClass, string> = {
  square: '2048*2048',
  landscape: '2560*1440',
  portrait: '1440*2560',
};

/** Wan 2.6-t2i / 2.5 (range 1280–1440 per sisi, default 1280*1280). */
const WAN26_SIZE: Record<ImageSizeClass, string> = {
  square: '1280*1280',
  landscape: '1440*1024',
  portrait: '1024*1440',
};

/** Wan 2.2 dan lebih lama / wanx (range 512–1440, default 1024*1024). */
const WAN_OLD_SIZE: Record<ImageSizeClass, string> = {
  square: '1024*1024',
  landscape: '1440*896',
  portrait: '896*1440',
};

/** OpenAI gpt-image-1 (juga default utk model image unknown). */
const GPT_IMAGE_SIZE: Record<ImageSizeClass, string> = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
};

/** OpenAI dall-e-3 (generations; DALL-E 3 tidak punya /edits). */
const DALLE3_SIZE: Record<ImageSizeClass, string> = {
  square: '1024x1024',
  landscape: '1792x1024',
  portrait: '1024x1792',
};

/** Size string utk dialek OpenAI menurut model (dall-e-3 beda daftar). */
function openaiSizeFor(model: string, cls: ImageSizeClass): string {
  return /^dall-e-3/i.test(bareModel(model)) ? DALLE3_SIZE[cls] : GPT_IMAGE_SIZE[cls];
}

/**
 * Size W*H utk model DashScope menurut family:
 *   - qwen-image-max/plus/plain → preset fixed MAX
 *   - qwen-image-2.x/3.x/… (series baru, range luas) → preset 2.0-style
 *   - wan2.7 → preset 2.7 (per sisi 768–4096)
 *   - wan2.6 dan wan2.5 → preset 2.6 (1280–1440)
 *   - wanx dan wan ≤ 2.2 → preset lama (512–1440)
 */
function dashscopeSizeFor(model: string, cls: ImageSizeClass): string {
  const m = bareModel(model);
  if (/^wan[-_]?2[._-]?7/i.test(m)) return WAN27_SIZE[cls];
  if (/^wan[-_]?2[._-]?[56]/i.test(m)) return WAN26_SIZE[cls];
  if (/^wan/i.test(m)) return WAN_OLD_SIZE[cls];
  if (/^qwen-image-(max|plus)(\b|-)/i.test(m) || m === 'qwen-image') return QWEN_SIZE_MAX[cls];
  return QWEN_SIZE_20[cls]; // qwen-image-2.0/3.0/… series baru
}

/* ───────────────────────── main entry (emit) ───────────────────────── */

/**
 * Map body image request OpenAI-kanonik → bentuk native target. Pure —
 * tidak mutate input; mengembalikan object baru (failover-safe: body asli
 * dipakai ulang antar target).
 *
 * Return:
 *   {kind:'json'}  → body JSON native (Kling / Qwen / OpenAI generations).
 *   {kind:'edits'} → target OpenAI & client membawa gambar referensi:
 *                    adapter harus redirect ke /v1/images/edits dan build
 *                    multipart (fields + file parts). Redirect ini struktural:
 *                    di dunia OpenAI "generasi dgn gambar referensi" hidup
 *                    di endpoint edits, bukan generations.
 */
export function mapImageInput(
  body: Record<string, unknown>,
  provider: Pick<Provider, 'id' | 'baseUrl'>,
  model: string,
): MappedImageRequest {
  const intent = parseIntent(body);
  const dialect = detectImageDialect(provider, model);

  if (dialect === 'kling') return emitKling(intent, model);
  if (dialect === 'qwen') return emitQwen(intent, model);
  return emitOpenai(intent, model);
}

/**
 * Model Kling yg punya knob resolution (v3-image: 1k/2k; v3-omni: 1k/2k/4k).
 * Generasi v1.x resolusinya fixed — TIDAK boleh dikirimi resolution (jaga
 * request v1.x yg sudah jalan tetap kompatibel).
 */
function klingSupportsResolution(model: string): boolean {
  return /^kling-(v)?3/i.test(bareModel(model)) || /omni/i.test(bareModel(model));
}

/** Emit dialek Kling (/v1/images/generations). */
function emitKling(intent: CanonicalImageIntent, model: string): MappedImageRequest {
  const out: Record<string, unknown> = { model_name: model };
  if (intent.prompt) out.prompt = intent.prompt;
  if (intent.negativePrompt) out.negative_prompt = intent.negativePrompt;
  // Kling API menerima SATU ref image di generations ini (multi-reference
  // endpoint terpisah, di luar scope) — ambil pertama, sisanya diabaikan.
  if (intent.images[0]) out.image = intent.images[0];
  if (intent.imageFidelity !== undefined) out.image_fidelity = intent.imageFidelity;
  if (intent.n !== undefined) out.n = intent.n;
  if (intent.sizeClass) out.aspect_ratio = KLING_ASPECT[intent.sizeClass];
  if (klingSupportsResolution(model)) {
    // Resolution eksplisit menang. Kalau client hanya kirim quality (dialek
    // OpenAI), bridge satu arah ke knob coarse Kling — high/hd→2k,
    // low/medium/standard→1k, auto/unknown→tidak kirim (default provider).
    // Pola sama dgn mapReasoning (effort → budget_tokens).
    if (intent.resolution) {
      out.resolution = intent.resolution;
    } else if (intent.quality) {
      const q = intent.quality.toLowerCase();
      if (q === 'high' || q === 'hd') out.resolution = '2k';
      else if (q === 'low' || q === 'medium' || q === 'standard') out.resolution = '1k';
      // 'auto' / nilai lain → biarkan default provider (never invent).
    }
  }
  if (intent.callbackUrl) out.callback_url = intent.callbackUrl;
  if (intent.externalTaskId) out.external_task_id = intent.externalTaskId;
  // watermark: hanya ada di varian Alibaba-hosted; teruskan bila client minta.
  if (intent.watermark !== undefined) out.watermark = intent.watermark;
  return { kind: 'json', body: out };
}

/** Wan versi lama (2.5 ke bawah + wanx) — request pakai input.prompt, bukan messages. */
function isLegacyWan(m: string): boolean {
  if (/^wanx/i.test(m)) return true;
  const vm = m.match(/^wan[-_]?2[._-]?(\d)/);
  return !!vm && Number(vm[1]) <= 5;
}

/** Emit dialek DashScope (Qwen-Image / Wan / Kling-hosted — envelope sama). */
function emitQwen(intent: CanonicalImageIntent, model: string): MappedImageRequest {
  const m = bareModel(model);

  // Kling via Alibaba Model Studio: envelope DashScope, tapi params NATIVE
  // Kling — aspect_ratio (bukan size!), resolution, n, watermark; tidak ada
  // negative_prompt/seed/prompt_extend.
  if (/^kling/i.test(m)) {
    const klingContent: Array<Record<string, unknown>> = intent.images.map((image) => ({ image }));
    if (intent.prompt) klingContent.push({ text: intent.prompt });
    const out: Record<string, unknown> = {
      model,
      input: { messages: [{ role: 'user', content: klingContent }] },
    };
    const params: Record<string, unknown> = {};
    if (intent.n !== undefined) params.n = intent.n;
    if (intent.sizeClass) params.aspect_ratio = KLING_ASPECT[intent.sizeClass];
    if (klingSupportsResolution(model)) {
      if (intent.resolution) params.resolution = intent.resolution;
      else if (intent.quality) {
        const q = intent.quality.toLowerCase();
        if (q === 'high' || q === 'hd') params.resolution = '2k';
        else if (q === 'low' || q === 'medium' || q === 'standard') params.resolution = '1k';
      }
    }
    if (intent.watermark !== undefined) params.watermark = intent.watermark;
    if (Object.keys(params).length > 0) out.parameters = params;
    return { kind: 'json', body: out };
  }

  // Wan 2.5 ke bawah / wanx: bentuk request era image-synthesis — input.prompt
  // (string), bukan messages. Async task → response handler output.task_id /
  // output.results[] sudah didukung gateway.
  if (isLegacyWan(m)) {
    const out: Record<string, unknown> = { model };
    const input: Record<string, unknown> = {};
    if (intent.prompt) input.prompt = intent.prompt;
    if (intent.negativePrompt) input.negative_prompt = intent.negativePrompt;
    if (Object.keys(input).length > 0) out.input = input;
    const params: Record<string, unknown> = {};
    if (intent.n !== undefined) params.n = intent.n;
    if (intent.sizeClass) params.size = dashscopeSizeFor(model, intent.sizeClass);
    if (intent.seed !== undefined) params.seed = intent.seed;
    if (Object.keys(params).length > 0) out.parameters = params;
    return { kind: 'json', body: out };
  }

  // Wan 2.6 / 2.7: kembali ke bentuk messages, params spesifik Wan.
  if (/^wan/i.test(m)) {
    const wanContent: Array<Record<string, unknown>> = intent.images.map((image) => ({ image }));
    if (intent.prompt) wanContent.push({ text: intent.prompt });
    const out: Record<string, unknown> = {
      model,
      input: { messages: [{ role: 'user', content: wanContent }] },
    };
    const params: Record<string, unknown> = {};
    if (intent.n !== undefined) params.n = intent.n;
    // Wan 2.7 menerima shorthand "1K"/"2K"/"4K" — resolution eksplisit
    // (dialek Kling) langsung jadi shorthand; tanpa itu, preset W*H per kelas.
    if (intent.resolution && /^wan[-_]?2[._-]?7/i.test(m)) {
      params.size = intent.resolution.toUpperCase(); // '1k' → '1K'
    } else if (intent.sizeClass) {
      params.size = dashscopeSizeFor(model, intent.sizeClass);
    }
    // negative_prompt dikecualikan wan2.7-image-pro & wan2.7-image (docs).
    if (intent.negativePrompt && !/^wan[-_]?2[._-]?7-image(-pro)?$/i.test(m)) {
      params.negative_prompt = intent.negativePrompt;
    }
    if (intent.enableSequential !== undefined) params.enable_sequential = intent.enableSequential;
    if (intent.thinkingMode !== undefined) params.thinking_mode = intent.thinkingMode;
    if (intent.colorPalette !== undefined) params.color_palette = intent.colorPalette;
    if (intent.maxImages !== undefined) params.max_images = intent.maxImages;
    if (intent.enableInterleave !== undefined) params.enable_interleave = intent.enableInterleave;
    if (Object.keys(params).length > 0) out.parameters = params;
    return { kind: 'json', body: out };
  }

  // Qwen-Image (gen & edit — bentuknya sama).
  const content: Array<Record<string, unknown>> = intent.images.map((image) => ({ image }));
  if (intent.prompt) content.push({ text: intent.prompt });
  const out: Record<string, unknown> = {
    model,
    input: { messages: [{ role: 'user', content }] },
  };
  const params: Record<string, unknown> = {};
  if (intent.n !== undefined) params.n = intent.n;
  if (intent.negativePrompt) params.negative_prompt = intent.negativePrompt;
  // qwen-image-edit (varian dasar) resolusinya mengikuti gambar input —
  // skip size. Series lain dapat resolusi kanonik utk kelas rasio-nya.
  if (intent.sizeClass && m !== 'qwen-image-edit') {
    params.size = dashscopeSizeFor(model, intent.sizeClass);
  }
  if (intent.seed !== undefined) params.seed = intent.seed;
  if (intent.promptExtend !== undefined) params.prompt_extend = intent.promptExtend;
  if (intent.promptExtendMode) params.prompt_extend_mode = intent.promptExtendMode;
  if (intent.watermark !== undefined) params.watermark = intent.watermark;
  if (Object.keys(params).length > 0) out.parameters = params;
  return { kind: 'json', body: out };
}

/**
 * Emit dialek OpenAI. Tanpa ref image → generations JSON biasa. Dengan ref
 * image → kind 'edits' (adapter redirect ke /v1/images/edits multipart);
 * field struktural image tidak pernah di-drop diam-diam utk OpenAI.
 */
function emitOpenai(intent: CanonicalImageIntent, model: string): MappedImageRequest {
  if (intent.images.length > 0) {
    const fields: Record<string, string> = { model };
    if (intent.prompt) fields.prompt = intent.prompt;
    if (intent.n !== undefined) fields.n = String(intent.n);
    if (intent.sizeClass) fields.size = openaiSizeFor(model, intent.sizeClass);
    for (const [k, v] of Object.entries(intent.openaiExtras)) {
      if (v !== undefined) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { kind: 'edits', fields, images: intent.images, mask: intent.mask };
  }
  const out: Record<string, unknown> = { model };
  if (intent.prompt) out.prompt = intent.prompt;
  if (intent.n !== undefined) out.n = intent.n;
  if (intent.sizeClass) out.size = openaiSizeFor(model, intent.sizeClass);
  // negative_prompt TIDAK ada padanannya di OpenAI → drop (strict validation
  // OpenAI akan 400 kalau field asing diteruskan). Field minor, aman drop.
  Object.assign(out, intent.openaiExtras);
  return { kind: 'json', body: out };
}
