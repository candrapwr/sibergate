/**
 * GeoIP lookup via MaxMind GeoLite2-Country.mmdb.
 *
 * File mmdb di-download on-demand (lihat downloader.ts) ke packages/core/data/.
 * Di-exclude dari backup & git (bukan data app, bisa re-download). Jika file
 * belum ada / gagal load, lookup return null — fitur tetap jalan tanpa flag.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Reader } from 'maxmind';
import type { CountryResponse } from 'maxmind';
import type { GeoIpResult } from './types.js';

/** Path mmdb (override via SIBERGATE_GEOIP_DB). */
export function geoipDbPath(): string {
  return resolve(process.env.SIBERGATE_GEOIP_DB ?? new URL('../../data/GeoLite2-Country.mmdb', import.meta.url).pathname);
}

let reader: Reader<CountryResponse> | null = null;
let loadError: string | null = null;

/** Lazy-load mmdb reader. Return null bila file tidak ada / korup. */
function getReader(): Reader<CountryResponse> | null {
  if (reader || loadError) return reader;
  const path = geoipDbPath();
  if (!existsSync(path)) {
    loadError = 'not-found';
    return null;
  }
  try {
    reader = new Reader<CountryResponse>(readFileSync(path));
    return reader;
  } catch (err) {
    loadError = (err as Error).message;
    return null;
  }
}

/** Reload reader (dipanggil setelah download mmdb baru). */
export function reloadGeoIp(): boolean {
  reader = null;
  loadError = null;
  return !!getReader();
}

/** Status mmdb file utk UI Settings. */
export function geoipStatus(): { present: boolean; path: string; sizeBytes: number; modifiedAt: string | null; loadError: string | null } {
  const path = geoipDbPath();
  let present = false;
  let sizeBytes = 0;
  let modifiedAt: string | null = null;
  try {
    const st = statSync(path);
    present = true;
    sizeBytes = st.size;
    modifiedAt = st.mtime.toISOString();
  } catch {
    /* not present */
  }
  // trigger lazy load utk capture loadError
  if (present) getReader();
  return { present, path, sizeBytes, modifiedAt, loadError };
}

/** Lookup negara + flag emoji dari IP. Null bila tidak ada DB / IP tak dikenal. */
export function lookupCountry(ip: string): GeoIpResult | null {
  if (!ip) return null;
  const r = getReader();
  if (!r) return null;
  try {
    const hit = r.get(ip);
    const iso = hit?.country?.iso_code ?? hit?.registered_country?.iso_code;
    if (!iso) return null;
    const name = hit?.country?.names?.en ?? hit?.registered_country?.names?.en ?? iso;
    return { country: iso, countryName: name, flag: countryCodeToFlag(iso) };
  } catch {
    return null;
  }
}

/**
 * Convert ISO 3166-1 alpha-2 country code → regional indicator emoji flag.
 * Mis. "US" → "🇺🇸", "SG" → "🇸🇬". Bila bukan 2 huruf valid → "🏳️".
 * Pure arithmetic, tanpa dep mapping table.
 */
export function countryCodeToFlag(iso: string | null | undefined): string {
  if (!iso || iso.length !== 2) return '🏳️';
  const code = iso.toUpperCase();
  const A = 0x1f1e6; // regional indicator A
  const base = 'A'.charCodeAt(0);
  const first = A + (code.charCodeAt(0) - base);
  const second = A + (code.charCodeAt(1) - base);
  // Validasi range A-Z
  if (code.charCodeAt(0) < base || code.charCodeAt(0) > base + 25) return '🏳️';
  if (code.charCodeAt(1) < base || code.charCodeAt(1) > base + 25) return '🏳️';
  return String.fromCodePoint(first, second);
}
