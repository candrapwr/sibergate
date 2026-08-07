/**
 * ProxyAgent cache — bangun dispatcher undici per proxy URL, di-cache utk
 * re-use (jangan bikin ProxyAgent baru tiap request → leak socket).
 *
 * undici ProxyAgent (Node 20+ bundled) mendukung HTTP, HTTPS, SOCKS5, SOCKS4
 * dari satu class. Auth di URL (`http://user:pass@host`) didukung native.
 */
import { ProxyAgent } from 'undici';

const cache = new Map<string, ProxyAgent>();

/** Protokol proxy yg didukung. */
export const ALLOWED_PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks4:', 'socks5h:', 'socks4a:'];

/** Validasi URL proxy. Return null bila invalid. */
export function validateProxyUrl(url: string): string | null {
  if (!url) return null;
  // Tolak karakter berbahaya (command injection via env).
  if (/[\n\r`$]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROXY_SCHEMES.includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Bangun/dapat ProxyAgent utk URL (cached). Throw bila URL invalid. */
export function buildDispatcher(proxyUrl: string): ProxyAgent {
  const validated = validateProxyUrl(proxyUrl);
  if (!validated) throw new Error(`Invalid proxy URL (must be http/https/socks5/socks4)`);
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
