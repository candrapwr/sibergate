/**
 * ProxyAgent cache — bangun dispatcher undici per proxy URL, di-cache utk
 * re-use (jangan bikin ProxyAgent baru tiap request → leak socket).
 *
 * undici ProxyAgent (Node 20+) mendukung HTTP, HTTPS, dan SOCKS5. SOCKS5 di
 * undici SUDAH resolve hostname remotely (anti DNS leak) — ekuivalen dgn
 * socks5h. Jadi kita terima socks5h:// & normalisasi ke socks5:// sebelum
 * construct (krn undici tolak scheme socks5h: secara harfiah).
 *
 * SOCKS4/SOCKS4a TIDAK didukung undici — di-tolak di validasi dgn pesan jelas.
 * Auth di URL (`http://user:pass@host`) didukung native.
 */
import { ProxyAgent } from 'undici';

const cache = new Map<string, ProxyAgent>();

/** Protokol proxy yg diterima user (sebelum normalisasi socks5h→socks5). */
const ACCEPTED_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * Validasi URL proxy. Return bentuk CANONICAL (socks5h: → socks5:) atau null
 * bila invalid / protocol tidak didukung (mis. socks4/socks4a).
 */
export function validateProxyUrl(url: string): string | null {
  if (!url) return null;
  if (/[\n\r`$]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'socks4:' || parsed.protocol === 'socks4a:') {
      // undici ProxyAgent tidak mendukung SOCKS4/4a. Tolak dgn eksplisit (caller
      // akan beri pesan — lihat buildDispatcher).
      return null;
    }
    if (!ACCEPTED_SCHEMES.has(parsed.protocol)) return null;
    // Normalisasi socks5h: → socks5: (undici socks5 native = remote DNS ekuivalen).
    let href = parsed.href;
    if (parsed.protocol === 'socks5h:') href = 'socks5:' + href.slice('socks5h:'.length);
    return href;
  } catch {
    return null;
  }
}

/** Bangun/dapat ProxyAgent utk URL (cached). Throw bila URL invalid/unsupported. */
export function buildDispatcher(proxyUrl: string): ProxyAgent {
  const validated = validateProxyUrl(proxyUrl);
  if (!validated) {
    // Pesan spesifik utk SOCKS4 (didukung curl tapi bukan undici).
    if (/^socks4/i.test(proxyUrl)) {
      throw new Error(`SOCKS4/4a not supported by the engine. Use SOCKS5 (which already resolves DNS remotely like socks5h).`);
    }
    throw new Error(`Invalid proxy URL (must be http/https/socks5/socks5h)`);
  }
  let agent = cache.get(validated);
  if (!agent) {
    agent = new ProxyAgent({ uri: validated });
    cache.set(validated, agent);
  }
  return agent;
}

/** Hapus agent dari cache & tutup (dipakai saat URL berubah / pool dihapus). */
export function evictDispatcher(proxyUrl: string): void {
  const validated = validateProxyUrl(proxyUrl);
  if (!validated) return;
  const agent = cache.get(validated);
  if (agent) {
    try {
      agent.close();
    } catch {
      /* ignore */
    }
    cache.delete(validated);
  }
}

/** Hapus seluruh cache (utk reload/reset). */
export function clearDispatcherCache(): void {
  for (const agent of cache.values()) {
    try {
      agent.close();
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
