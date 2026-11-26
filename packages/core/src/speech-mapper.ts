import type { Provider } from './types.js';

/**
 * Speech mapper — pola sama dengan image-mapper.ts, untuk TTS.
 *
 * Klien selalu mengirim body standar OpenAI /v1/audio/speech:
 *   { model, input, voice, response_format?, speed?, sample_rate? }
 *
 * Dengan route target `mapping: 'auto'`, adapter speech menerjemahkan body
 * itu ke dialek native target (detectSpeechDialect) dan menormalkan response
 * upstream kembali menjadi binary audio — persis seperti image generation
 * (parse intent → deteksi dialek → emit native; response dinormalisasi).
 *
 * Dialek 'qwen' = DashScope SpeechSynthesizer (Qwen TTS / CosyVoice):
 *   request : { model, input: { text, voice, format, sample_rate, rate? } }
 *   response: JSON { output: { audio: { data? base64, url? }, finish_reason },
 *                    usage: { characters }, request_id }
 *             atau error top-level { code, message }.
 *
 * Dialek 'gemini' = Google generateContent dengan responseModalities AUDIO:
 *   request : POST {baseUrl}/models/{model}:generateContent
 *             { contents:[{role:'user',parts:[{text}]}],
 *               generationConfig:{ responseModalities:['AUDIO'],
 *                 speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName}}} } }
 *   response: { candidates:[{content:{parts:[{inlineData:{mimeType, data:base64}}]}}] }
 *   Model baru mengembalikan WAV (RIFF) 24 kHz siap pakai; model lama
 *   'audio/L16;…' (raw PCM) → dibungkus header WAV oleh gateway. 'pcm'
 *   diminta → header WAV dilepas, dikirim raw.
 *
 * Dialek 'openai' = passthrough body OpenAI + model upstream (response sudah
 * binary audio; tidak ada yang perlu dikonversi).
 *
 * TTS bersifat synchronous — tidak ada async task/polling seperti image/video.
 */

/* ───────────────────────────── intent kanonik ───────────────────────────── */

export interface CanonicalSpeechIntent {
  /** Teks yang akan diucapkan. */
  text: string;
  /** Voice id (OpenAI: alloy/echo/…; Qwen per-model: longanlingxi/longanlingxin/…). */
  voice: string;
  /** true bila klien mengirim `voice` sendiri; false = pakai default per-model. */
  voiceExplicit: boolean;
  /** Format audio output: mp3 | wav | pcm | opus (Qwen tidak punya aac/flac). */
  format: string;
  /** Sample rate Hz (default 22050 — default Qwen TTS). */
  sampleRate: number;
  /** Kecepatan bicara (OpenAI `speed`; Qwen `rate`). Null = default upstream. */
  rate: number | null;
}

/** Format audio yang didukung dialek Qwen + Content-Type binary-nya. */
export const QWEN_SPEECH_FORMATS: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/L16',
  opus: 'audio/ogg',
};

// Voice default utk dialek Qwen BILA klien tidak mengirim `voice`.
// Voice id bersifat PER-MODEL (teruji live di upstream):
//   qwen-audio-3.0-tts-flash → 'longanlingxi'   ('longanlingxin' → engine 411)
//   qwen-audio-3.0-tts-plus  → 'longanlingxin'  ('longanlingxi'  → engine 411)
//   qwen-audio-3.1-*         → 'longanlingxin_v3.1' (suffiks versi)
// Karena itu default di-resolve per nama model, bukan satu konstanta.
export function defaultVoiceForModel(model: string): string {
  const m = model.toLowerCase();
  if (/3[.-]1/.test(m)) return 'longanlingxin_v3.1';
  if (/plus/.test(m)) return 'longanlingxin';
  return 'longanlingxi';
}
export const DEFAULT_SPEECH_VOICE = 'longanlingxi';
export const DEFAULT_SPEECH_SAMPLE_RATE = 22050;

// Voice default dialek Gemini TTS bila klien tidak mengirim `voice`.
// Daftar prebuilt voice Gemini (30): Zephyr, Puck, Charon, Kore, Fenrir,
// Leda, Orus, Aoede, … — case-sensitive di upstream.
export const DEFAULT_GEMINI_SPEECH_VOICE = 'Kore';
/** Gemini TTS selalu mengeluarkan raw PCM s16le mono pada rate ini. */
export const GEMINI_SPEECH_SAMPLE_RATE = 24000;

/**
 * Parse body OpenAI /v1/audio/speech menjadi intent kanonik. Field yang tidak
 * dikenal diabaikan (dialek native punya field sendiri). `input` boleh string
 * atau array of strings (sebagian client SDK mengirim array).
 */
export function parseSpeechIntent(body: Record<string, unknown>): CanonicalSpeechIntent {
  let text = body.input;
  if (Array.isArray(text)) text = text.map((x) => String(x)).join(' ');
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error("Field 'input' (teks yang akan diucapkan) wajib diisi.");
  }

  const voiceRaw = typeof body.voice === 'string' ? body.voice.trim() : '';
  // Voice default di-resolve per model (lihat defaultVoiceForModel) —
  // parseIntent belum tahu model, jadi tandai non-eksplisit di sini dan
  // mapSpeechInput yang meng-isi setelah dialek+model diketahui.
  const voiceExplicit = voiceRaw.length > 0;
  const voice = voiceExplicit ? voiceRaw : DEFAULT_SPEECH_VOICE;

  let format = String(body.response_format ?? 'mp3').toLowerCase();
  // OpenAI mengenal aac/flac; Qwen TTS hanya mp3/wav/pcm/opus → fallback mp3.
  if (!(format in QWEN_SPEECH_FORMATS)) format = 'mp3';

  const sr = Number(body.sample_rate);
  const sampleRate = Number.isFinite(sr) && sr > 0 ? Math.round(sr) : DEFAULT_SPEECH_SAMPLE_RATE;

  const speed = Number(body.speed);
  const rate = Number.isFinite(speed) && speed > 0 ? speed : null;

  return { text, voice, voiceExplicit, format, sampleRate, rate };
}

/* ───────────────────────────── deteksi dialek ───────────────────────────── */

export type SpeechDialect = 'qwen' | 'gemini' | 'openai';

/** Strip prefix provider ('qwencloud/qwen3-tts-flash' → 'qwen3-tts-flash'). */
function bareModel(model: string): string {
  const i = model.lastIndexOf('/');
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

/**
 * Deteksi dialek TTS target. Prioritas (sama dengan detectImageDialect):
 * provider id → baseUrl → family model. Unknown → 'openai' (default aman).
 *
 * Host token-plan (*.maas.aliyuncs.com) juga terdeteksi 'qwen' — envelope
 * DashScope sama, tapi akun plan tidak melayani model TTS ("Model not exist");
 * itu masalah credential/endpoint yang dilaporkan upstream apa adanya.
 */
export function detectSpeechDialect(provider: Pick<Provider, 'id' | 'baseUrl'>, model: string): SpeechDialect {
  const pid = provider.id.toLowerCase();
  if (pid === 'qwen' || pid === 'qwencloud' || pid === 'qwenplan' || pid === 'dashscope' || pid === 'alibaba' || pid === 'aliyun') return 'qwen';
  if (pid === 'gemini' || pid === 'google' || pid === 'googleai' || pid === 'vertex') return 'gemini';
  if (/dashscope|aliyuncs|qwencloudapi/i.test(provider.baseUrl)) return 'qwen';
  if (/generativelanguage\.googleapis|aiplatform\.googleapis/i.test(provider.baseUrl)) return 'gemini';
  const m = bareModel(model);
  if (/tts|cosyvoice|sambert/.test(m) && /^qwen|^cosyvoice|^sambert/.test(m)) return 'qwen';
  if (/^gemini.*tts/.test(m)) return 'gemini';
  return 'openai';
}

/* ───────────────────────────── emit native ───────────────────────────── */

/** Body native DashScope SpeechSynthesizer (Qwen TTS). */
export function emitQwenSpeech(intent: CanonicalSpeechIntent, model: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text: intent.text,
    voice: intent.voice,
    format: intent.format,
    sample_rate: intent.sampleRate,
  };
  if (intent.rate !== null) input.rate = intent.rate;
  return { model, input };
}

/**
 * Body native Gemini TTS (generateContent + responseModalities AUDIO).
 * Format/sampleRate/rate OpenAI tidak punya padanan di Gemini TTS —
 * audio selalu PCM 24 kHz; format di-handle saat menormalkan response.
 */
export function emitGeminiSpeech(intent: CanonicalSpeechIntent): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text: intent.text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: intent.voice } },
      },
    },
  };
}

/**
 * Terjemahkan body OpenAI-kanonik → body native target (mode mapping='auto').
 * Dialek 'openai' = body OpenAI apa adanya dengan model upstream di-inject
 * (adapter menanganinya sebagai passthrough; fungsi ini tetap mengembalikan
 * body yang valid supaya kontrak mapper seragam).
 */
export function mapSpeechInput(
  body: Record<string, unknown>,
  provider: Pick<Provider, 'id' | 'baseUrl'>,
  model: string,
): { dialect: SpeechDialect; intent: CanonicalSpeechIntent; body: Record<string, unknown> } {
  const dialect = detectSpeechDialect(provider, model);
  const intent = parseSpeechIntent(body);
  if (dialect === 'qwen') {
    // Klien tidak kirim voice → pakai default yang cocok utk model target
    // (id voice beda per model: flash 'longanlingxi', plus 'longanlingxin',
    // 3.1 'longanlingxin_v3.1').
    if (!intent.voiceExplicit) intent.voice = defaultVoiceForModel(model);
    return { dialect, intent, body: emitQwenSpeech(intent, model) };
  }
  if (dialect === 'gemini') {
    if (!intent.voiceExplicit) intent.voice = DEFAULT_GEMINI_SPEECH_VOICE;
    return { dialect, intent, body: emitGeminiSpeech(intent) };
  }
  return { dialect, intent, body: { ...body, model } };
}

/* ───────────────────────────── response → binary ───────────────────────────── */

/**
 * Deteksi envelope audio DashScope: { output: { audio: { data | url } } }.
 * Dipakai adapter untuk memutuskan perlu decode JSON → binary atau tidak.
 */
export function isQwenSpeechAudioBody(body: unknown): body is { output: { audio: { data?: string; url?: string } } } {
  if (!body || typeof body !== 'object') return false;
  const output = (body as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return false;
  const audio = (output as { audio?: unknown }).audio;
  if (!audio || typeof audio !== 'object') return false;
  const a = audio as { data?: unknown; url?: unknown };
  return typeof a.data === 'string' || typeof a.url === 'string';
}

/**
 * Ambil bytes audio dari response DashScope: base64 `output.audio.data`
 * langsung di-decode; bila hanya ada `url`, caller yang mengunduhnya
 * (lihat adapters/speech.ts). Return null bila tidak ada audio.
 */
export function decodeQwenSpeechAudio(body: unknown): Buffer | null {
  if (!isQwenSpeechAudioBody(body)) return null;
  const data = body.output.audio.data;
  if (typeof data === 'string' && data) {
    // data boleh data-URL (data:audio/mpeg;base64,...) atau base64 mentah.
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(data);
    const b64 = (m ? m[1]! : data).replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  return null;
}

/** URL audio bila response DashScope hanya memberi link (bukan base64). */
export function qwenSpeechAudioUrl(body: unknown): string | null {
  if (!isQwenSpeechAudioBody(body)) return null;
  const url = body.output.audio.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Content-Type binary untuk format audio hasil (default audio/mpeg). */
export function speechContentType(format: string): string {
  return QWEN_SPEECH_FORMATS[format] ?? 'application/octet-stream';
}

/* ───────────────────── Gemini: response → binary ───────────────────── */

/**
 * Ambil audio dari response generateContent Gemini TTS:
 * candidates[].content.parts[].inlineData { mimeType, data(base64) }.
 * Bisa terpecah di beberapa part/candidate (streaming) → digabung berurutan.
 * Return { pcm, mimeType } atau null bila tidak ada inline audio.
 */
export function decodeGeminiSpeechAudio(body: unknown): { audio: Buffer; mimeType: string } | null {
  const candidates = (body as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates)) return null;
  const chunks: Buffer[] = [];
  let mimeType = '';
  for (const cand of candidates) {
    const parts = (cand as { content?: { parts?: unknown } })?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = (part as { inlineData?: { mimeType?: unknown; data?: unknown } })?.inlineData;
      if (inline && typeof inline.data === 'string' && inline.data) {
        const b64 = inline.data.replace(/\s+/g, '');
        chunks.push(Buffer.from(b64, 'base64'));
        if (!mimeType && typeof inline.mimeType === 'string') mimeType = inline.mimeType;
      }
    }
  }
  if (chunks.length === 0) return null;
  return { audio: Buffer.concat(chunks), mimeType: mimeType || 'audio/L16;codec=pcm;rate=24000' };
}

/** Parse sample rate dari mimeType Gemini ('audio/L16;codec=pcm;rate=24000'). */
export function geminiPcmRate(mimeType: string): number {
  const m = /rate=(\d+)/i.exec(mimeType);
  return m ? Number(m[1]) : GEMINI_SPEECH_SAMPLE_RATE;
}

/**
 * Bungkus raw PCM s16le mono menjadi WAV (header RIFF 44-byte) supaya bisa
 * langsung diputar client. Gemini TTS hanya mengeluarkan PCM; tanpa header
 * ini player/browser tidak bisa memainkannya.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Normalisasi audio Gemini ke format yang diminta klien. Upstream bisa
 * memberi WAV (RIFF, model baru) atau raw PCM (audio/L16, model lama).
 * Tidak ada encoder mp3/opus di gateway — selain 'pcm', hasil selalu WAV
 * (header valid utk player umum): WAV diteruskan, PCM dibungkus header.
 * 'pcm' → raw s16le (header WAV dilepas bila ada).
 * Return { audio, contentType }.
 */
export function geminiSpeechToFormat(audio: Buffer, mimeType: string, requested: string): { audio: Buffer; contentType: string } {
  const isWav = audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
  if (requested === 'pcm') {
    // Cari chunk 'data' bila WAV (header fmt bisa bervariasi); fallback 44.
    if (isWav) {
      const idx = audio.indexOf(Buffer.from('data', 'ascii'), 12);
      return { audio: audio.subarray(idx >= 0 ? idx + 8 : 44), contentType: 'audio/L16' };
    }
    return { audio, contentType: 'audio/L16' };
  }
  if (isWav) return { audio, contentType: 'audio/wav' };
  return { audio: pcmToWav(audio, geminiPcmRate(mimeType)), contentType: 'audio/wav' };
}