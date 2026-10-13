/**
 * Mapping request OpenAI-compatible → arguments tool MCP, berbasis inputSchema
 * tool (JSON Schema dari tools/list).
 *
 * Prinsip: cocokkan SEMANTIK input (prompt, aspect ratio, durasi, gambar
 * referensi, jumlah output) ke properti schema yang namanya dikenali, lalu
 * koersi nilai sesuai tipe/enum schema. Properti required yang tidak punya
 * pasangan semantik diisi nilai default bila enum tersedia. Argumen yang tidak
 * dikenali TIDAK diteruskan (mencegah error schema upstream).
 */

export interface ArgMappingInput {
  prompt?: string;
  negativePrompt?: string;
  /** Kelas rasio (dari size OpenAI / aspect_ratio Kling). */
  sizeClass?: 'square' | 'landscape' | 'portrait' | null;
  /** Durasi video dalam detik. */
  duration?: number;
  /** URL/base64 gambar referensi (image-to-image / image-to-video). */
  imageRefs?: string[];
  /** Jumlah output yang diminta klien. */
  n?: number;
  /** Nama model/versi spesifik bila klien menyebut (mis. 'kling-v2'). */
  model?: string;
  /** Field request klien lain utk pass-through bila schema tool punya properti serupa. */
  extra?: Record<string, unknown>;
}

export type JsonSchema = Record<string, unknown>;

/** Ambil bagian `properties` dari inputSchema tool. */
export function schemaProperties(schema?: JsonSchema): Record<string, JsonSchema> {
  const props = schema?.properties;
  return props && typeof props === 'object' ? (props as Record<string, JsonSchema>) : {};
}

/** Cari nama properti schema yang match salah satu pattern (urutan = prioritas). */
function findProp(props: Record<string, JsonSchema>, patterns: RegExp[]): string | null {
  const names = Object.keys(props);
  for (const pattern of patterns) {
    const hit = names.find((n) => pattern.test(n));
    if (hit) return hit;
  }
  return null;
}

/** Enum values dari schema property (string enum / oneOf/anyOf const). */
function enumValues(schema?: JsonSchema): unknown[] {
  if (!schema) return [];
  if (Array.isArray(schema.enum)) return schema.enum;
  const variants = [...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])];
  const consts = variants
    .map((v) => (v && typeof v === 'object' ? (v as JsonSchema).const : undefined))
    .filter((v): v is unknown => v !== undefined);
  return consts;
}

/** Pilih anggota enum yang paling cocok dgn nilai target (equal > contains). */
function pickEnum(values: unknown[], target: string): string | undefined {
  const lower = target.toLowerCase();
  const exact = values.find((v) => typeof v === 'string' && v.toLowerCase() === lower);
  if (exact !== undefined) return String(exact);
  // Partial match hanya utk kandidat cukup panjang (≥3 char) supaya enum
  // pendek ('a', 'hd') tidak cocok secara kebetulan dgn string panjang.
  const partial = values.find(
    (v) => typeof v === 'string' && v.length >= 3 && (v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase())),
  );
  return partial !== undefined ? String(partial) : undefined;
}

/** Koersi nilai ke tipe yang dideklarasikan schema. */
function coerce(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return value;
  const enums = enumValues(schema);
  if (enums.length && (typeof value === 'string' || typeof value === 'number')) {
    return pickEnum(enums, String(value)) ?? value;
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) return undefined;
      const rounded = type === 'integer' ? Math.round(num) : num;
      if (typeof schema.minimum === 'number') return Math.max(schema.minimum, rounded);
      if (typeof schema.maximum === 'number') return Math.min(schema.maximum, rounded);
      return rounded;
    }
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' || value === true;
    default:
      return value;
  }
}

const ASPECT_BY_CLASS: Record<Exclude<NonNullable<ArgMappingInput['sizeClass']>, null>, string[]> = {
  square: ['1:1', '4:3', '3:4'],
  landscape: ['16:9', '4:3', '3:2'],
  portrait: ['9:16', '3:4', '2:3'],
};

const SIZE_BY_CLASS: Record<Exclude<NonNullable<ArgMappingInput['sizeClass']>, null>, string> = {
  square: '1024x1024',
  landscape: '1280x720',
  portrait: '720x1280',
};

/** Size string OpenAI ("1024x1024") → kelas rasio. */
export function sizeToClass(size?: string): 'square' | 'landscape' | 'portrait' | null {
  if (!size) return null;
  const match = size.toLowerCase().match(/^(\d+)x(\d+)$/);
  if (!match) {
    if (size.includes(':')) {
      const [w, h] = size.split(':').map(Number);
      if (w && h) return w === h ? 'square' : w > h ? 'landscape' : 'portrait';
    }
    return null;
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

/**
 * Bangun arguments tool dari input semantik + schema tool.
 * Bila schema kosong/tidak ada properties → teruskan pasangan yang jelas saja
 * (prompt, dst.) dengan nama properti paling umum.
 */
export function mapToToolArguments(schema: JsonSchema | undefined, input: ArgMappingInput): Record<string, unknown> {
  const props = schemaProperties(schema);
  const args: Record<string, unknown> = {};

  // ── prompt ──
  const promptProp = findProp(props, [/^(text_)?prompt(_text)?$/, /^prompt$/, /^text$/, /^description$/, /^content$/]);
  if (input.prompt && promptProp) args[promptProp] = coerce(input.prompt, props[promptProp]);

  // ── negative prompt ──
  const negProp = findProp(props, [/^negative_?prompt$/, /^neg_?prompt$/]);
  if (input.negativePrompt && negProp) args[negProp] = coerce(input.negativePrompt, props[negProp]);

  // ── aspect ratio / size ──
  if (input.sizeClass) {
    const aspectProp = findProp(props, [/^aspect_?ratio$/, /^ratio$/, /^aspect$/]);
    if (aspectProp) {
      const enums = enumValues(props[aspectProp]);
      let value: string | undefined;
      for (const candidate of ASPECT_BY_CLASS[input.sizeClass]) {
        value = enums.length ? pickEnum(enums, candidate) : candidate;
        if (value) break;
      }
      if (value) args[aspectProp] = coerce(value, props[aspectProp]);
    } else {
      const sizeProp = findProp(props, [/^size$/, /^resolution$/, /^dimensions?$/]);
      if (sizeProp) {
        const enums = enumValues(props[sizeProp]);
        const fallback = SIZE_BY_CLASS[input.sizeClass];
        const value = enums.length
          ? (pickEnum(enums, input.sizeClass) ?? pickEnum(enums, fallback))
          : fallback;
        if (value) args[sizeProp] = coerce(value, props[sizeProp]);
      }
    }
  }

  // ── durasi (video) ──
  if (input.duration !== undefined) {
    const durProp = findProp(props, [/^duration$/, /^duration_?s(econds)?$/, /^seconds?$/, /^length$/, /^video_?length$/]);
    if (durProp) {
      const coerced = coerce(input.duration, props[durProp]);
      if (coerced !== undefined) args[durProp] = coerced;
    }
  }

  // ── gambar referensi ──
  if (input.imageRefs?.length) {
    // Slot bernomor ala Kling (dari who_am_i inputs): first_image, image_1..N,
    // subject_image_0..N, video_1 — ref didistribusikan berurutan.
    const numberedSlots = Object.keys(props)
      .filter((n) => /^(first_image|image_\d+|subject_image_\d+|video_1)$/.test(n))
      .sort((a, b) => slotOrder(a) - slotOrder(b));
    const singleProp = findProp(props, [/^image$/, /^image_?url$/, /^input_?image$/, /^reference_?image$/, /^image_?ref$/, /^first_?frame$/, /^start_?frame$/, /^images?$/]);
    if (numberedSlots.length) {
      input.imageRefs.slice(0, numberedSlots.length).forEach((ref, i) => {
        const coerced = coerce(ref, props[numberedSlots[i]!]);
        if (coerced !== undefined) args[numberedSlots[i]!] = coerced;
      });
    } else if (singleProp) {
      const schema = props[singleProp];
      const type = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
      if (type === 'array' || input.imageRefs.length > 1) {
        const itemSchema = (schema?.items ?? {}) as JsonSchema;
        args[singleProp] = input.imageRefs.map((ref) => coerce(ref, itemSchema)).filter((v) => v !== undefined);
      } else {
        const coerced = coerce(input.imageRefs[0], schema);
        if (coerced !== undefined) args[singleProp] = coerced;
      }
    }
  }

  // ── jumlah output ──
  if (input.n && input.n > 1) {
    const nProp = findProp(props, [/^n$/, /^num_?images?$/, /^image_?num$/, /^num_?infer$/, /^count$/, /^image_?count$/]);
    if (nProp) {
      const coerced = coerce(input.n, props[nProp]);
      if (coerced !== undefined) args[nProp] = coerced;
    }
  }

  // ── model/versi ──
  if (input.model) {
    const modelProp = findProp(props, [/^model(_name)?$/, /^version$/, /^engine$/]);
    if (modelProp) {
      const enums = enumValues(props[modelProp]);
      // Nilai tak dikenal tetap diteruskan apa adanya — server yang menolak
      // dgn error jelas (lebih baik fail-loud daripada diam-diba pakai default).
      const value = enums.length ? (pickEnum(enums, input.model) ?? input.model) : input.model;
      if (value) args[modelProp] = coerce(value, props[modelProp]);
    }
  }

  // ── pass-through field klien lain bila schema punya properti serupa ──
  if (input.extra) {
    const propNames = Object.keys(props);
    for (const [key, value] of Object.entries(input.extra)) {
      if (value === undefined || value === null || value === '') continue;
      if (propNames.includes(key)) {
        const coerced = coerce(value, props[key]);
        if (coerced !== undefined && !(key in args)) args[key] = coerced;
      }
    }
  }

  // ── required yang belum terisi: isi default enum pertama bila ada ──
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]) : [];
  for (const req of required) {
    if (req in args) continue;
    const schemaProp = props[req];
    const enums = enumValues(schemaProp);
    if (enums.length && typeof enums[0] === 'string') args[req] = enums[0];
    else if (schemaProp && (schemaProp.type === 'number' || schemaProp.type === 'integer')) args[req] = 1;
  }

  return args;
}

/** Urutan slot media: first/subject/image dinomori, video paling akhir. */
function slotOrder(name: string): number {
  if (/^first_image$/.test(name)) return 0;
  const m = name.match(/^(subject_image|image|video)_(\d+)$/);
  if (!m) return 50;
  const group = m[1] === 'subject_image' ? 0 : m[1] === 'image' ? 10 : 20;
  return group + Number(m[2]);
}
