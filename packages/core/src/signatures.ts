/**
 * In-memory cache of Gemini `thought_signature` per tool_call.
 *
 * Gemini 3.x menyertakan `extra_content.google.thought_signature` di setiap
 * tool_call (response). Signature tsb WAJIB dikirim balik di assistant message
 * tool_calls saat request multi-turn — kalau hilang, Gemini balas 400
 * "Function call is missing a thought_signature".
 *
 * Karena format OpenAI murni tidak punya field tsb, gateway:
 *   1. CAPTURE signature dari response Gemini (key: tool_call.id)
 *   2. STRIP extra_content dari response → client dapat format OpenAI murni
 *   3. INJECT signature balik ke body.messages saat request multi-turn datang
 *
 * Khusus Gemini (deteksi by field presence `extra_content.google`, supaya
 * cover Gemini-via-OpenRouter juga). Provider lain skip otomatis.
 *
 * In-memory krn signature itu ephemeral (hanya relevan utk 1 conversation).
 * TTL 1 jam + cap 5000 entry cegah memory leak. Reset saat restart (acceptable:
 * conversation multi-turn aktif saat restart perlu re-init).
 */

const TTL_MS = 3600_000; // signature >1 jam dianggap basi, auto-expire
const MAX_ENTRIES = 5000; // hard cap; bila terlewati, entry terlama di-evict

interface CachedSignature {
  signature: string;
  providerId: string;
  createdAt: number;
}

const cache = new Map<string, CachedSignature>(); // key: tool_call.id

/**
 * Dynamic default signature fallback — per-provider. Saat gateway capture
 * signature pertama yg valid dari sebuah provider, disimpan jg sbg default.
 * Dipakai saat cache miss by-id (mis. server restart di tengah conversation
 * multi-turn aktif, shg signature by-id hilang). Inject default lebih baik
 * drpd kosong: Google saat ini menerima signature non-valid, dan default yg
 * berasal dari provider yg sama lebih mungkin diterima drpd placeholder acak.
 *
 * Ini mekanisme anti-restart: signature asli (by-id) = fidelity tinggi;
 * default fallback = safety net. Mirip strategi 9Router (static default) tapi
 * dynamic — nilai default didapat dari provider sendiri, bukan hardcode.
 */
const defaultByProvider = new Map<string, { signature: string; createdAt: number }>();

/**
 * Simpan signature utk sebuah tool_call.id. Evict entry terlama bila cap tercapai
 * (Map maintain insertion order di JS, jadi iterasi pertama = tertua). Insertion-
 * order juga dipakai sbg LRU kasar: get() re-insert utk update recency (opsional).
 *
 * Juga update default provider (fallback anti-restart) bila signature ini lebih
 * baru dari yg tersimpan.
 */
export function storeSignature(toolCallId: string, signature: string, providerId: string): void {
  // Cap: bila sudah penuh DAN id baru (bukan update), evict entry tertua.
  if (cache.size >= MAX_ENTRIES && !cache.has(toolCallId)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const now = Date.now();
  cache.set(toolCallId, { signature, providerId, createdAt: now });
  // Anti-restart fallback: simpan/refresh default utk provider ini.
  const prev = defaultByProvider.get(providerId);
  if (!prev || now > prev.createdAt) {
    defaultByProvider.set(providerId, { signature, createdAt: now });
  }
}

/**
 * Ambil signature utk tool_call.id. Return null bila tidak ada atau sudah expired
 * (TTL). Bila expired, hapus (lazy eviction). Touch recency (re-insert) supaya
 * entry yg sering dipakai tidak gampang ter-evict.
 */
export function getSignature(toolCallId: string): string | null {
  const entry = cache.get(toolCallId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    cache.delete(toolCallId); // basi, hapus
    return null;
  }
  // Re-insert supaya recency ter-update (LRU-ish).
  cache.delete(toolCallId);
  cache.set(toolCallId, entry);
  return entry.signature;
}

/**
 * Ambil signature DEFAULT utk provider (anti-restart fallback). Dipakai saat
 * getSignature(id) miss (cache hilang krn restart / sesi lama). Return null bila
 * provider belum pernah lihat signature sama sekali (mis. fresh start total).
 */
export function getDefaultSignature(providerId: string): string | null {
  const entry = defaultByProvider.get(providerId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    defaultByProvider.delete(providerId); // basi
    return null;
  }
  return entry.signature;
}

export interface SignatureListEntry {
  id: string;
  providerId: string;
  ageMs: number;
}

export interface SignatureList {
  count: number;
  /** Sample 50 entry terbaru utk monitoring (bukan semua — bisa ribuan). */
  entries: SignatureListEntry[];
}

/** Snapshot cache utk monitoring UI. Hanya metadata (id/provider/age), bukan signature value. */
export function listSignatures(): SignatureList {
  const now = Date.now();
  const all = [...cache.entries()].map(([id, e]) => ({
    id,
    providerId: e.providerId,
    ageMs: now - e.createdAt,
  }));
  // Entry terbaru duluan (paling relevan utk monitoring).
  all.sort((a, b) => a.ageMs - b.ageMs);
  return { count: cache.size, entries: all.slice(0, 50) };
}

/**
 * Hapus semua signature. Dipakai oleh tombol "Clear signatures" di Settings.
 * Return jumlah entry yg dihapus (utk konfirmasi UI).
 */
export function resetSignatures(): { cleared: number } {
  const cleared = cache.size;
  cache.clear();
  defaultByProvider.clear();
  return { cleared };
}
