/**
 * GeoLite2 mmdb downloader — download on-demand dari URL configurable.
 *
 * Default: mirror P3TERX (github.com/P3TERX/GeoLite.mmdb) — MaxMind official DB
 * re-published di GitHub Releases, TANPA license key & registrasi. URL bisa
 * diganti via UI Settings (body SIBERGATE_GEOIP_DB_URL / arg downloadGeoIpDb).
 *
 * Mendukung 2 format download:
 *   - .mmdb mentah        → langsung pakai (paling cepat, default P3TERX).
 *   - .tar.gz / .tar      → extract, ambil file .mmdb pertama (MaxMind official).
 *
 * File disimpan ke geoipDbPath(); reloadGeoIp() re-load reader setelah selesai.
 */
import {
  createWriteStream,
  mkdirSync,
  unlinkSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { x as tarExtract } from 'tar';
import { geoipDbPath, reloadGeoIp } from './geoip.js';

export interface DownloadResult {
  ok: boolean;
  sizeBytes?: number;
  error?: string;
  url?: string;
}

/** URL mirror default (P3TERX, MaxMind official re-published, no auth). */
const DEFAULT_DB_URL =
  'https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-Country.mmdb';

/**
 * Resolve URL download. Priority:
 *   1. arg eksplisit (dari UI)
 *   2. env SIBERGATE_GEOIP_DB_URL
 *   3. default P3TERX mirror
 */
function resolveUrl(argUrl?: string): string {
  const u = (argUrl ?? process.env.SIBERGATE_GEOIP_DB_URL ?? DEFAULT_DB_URL).trim();
  return u;
}

/**
 * Download GeoLite2-Country. URL default = mirror P3TERX (no auth). Bisa juga
 * MaxMind official (butuh license key di URL via basic auth — kasus user-supplied).
 */
export async function downloadGeoIpDb(argUrl?: string): Promise<DownloadResult> {
  const url = resolveUrl(argUrl);
  const dest = geoipDbPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmpDir = await mkdtemp(join(tmpdir(), 'sibergate-geoip-'));
  const isTarball = /\.tar(\.gz|\.bz2)?$|\.tgz$/i.test(url);
  const tmpFile = join(tmpDir, isTarball ? 'geoip.tar.gz' : 'geoip.mmdb');

  try {
    // 1. Download. Pakai Authorization header HANYA bila user sertakan via env
    //    (MaxMind official butuh basic auth dgn license key sbg username).
    const headers: Record<string, string> = {};
    const licenseKey = process.env.SIBERGATE_MAXMIND_LICENSE_KEY;
    if (licenseKey && /maxmind\.com/i.test(url)) {
      headers.Authorization = `Basic ${Buffer.from(`${licenseKey}:`).toString('base64')}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) {
      return { ok: false, error: `Download failed: HTTP ${res.status} ${res.statusText}`, url };
    }
    // Stream body ke file (pipeline menunggu flush selesai, hindari race).
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tmpFile));

    // 2. Dapatkan file mmdb final.
    let finalFile: string;
    if (isTarball) {
      // Extract tar.gz, cari .mmdb.
      await tarExtract({ file: tmpFile, cwd: tmpDir });
      const found = findMmdb(tmpDir);
      if (!found) return { ok: false, error: 'No .mmdb file found in archive.', url };
      finalFile = found;
    } else {
      // Asumsi .mmdb mentah. MaxMind format menaruh metadata marker (\xab\xcd\xef
      // "MaxMind.com") di AKHIR file, bukan awal — jadi cek di 256 byte terakhir.
      const size = statSync(tmpFile).size;
      const fh = await import('node:fs/promises').then((m) => m.open(tmpFile, 'r'));
      const tail = Buffer.allocUnsafe(Math.min(256, size));
      await fh.read(tail, 0, tail.length, Math.max(0, size - tail.length));
      await fh.close();
      if (!tail.includes(Buffer.from('MaxMind.com'), 0, 'latin1')) {
        return { ok: false, error: 'Downloaded file is not a valid MaxMind mmdb (no metadata marker).', url };
      }
      finalFile = tmpFile;
    }

    // 3. Pindahkan ke dest. renameSync bisa gagal EXDEV bila tmp & dest beda
    // filesystem (mis. /tmp vs /Volumes) — fallback ke copy+delete.
    if (existsSync(dest)) unlinkSync(dest);
    try {
      renameSync(finalFile, dest);
    } catch {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(finalFile, dest);
      unlinkSync(finalFile);
    }
    reloadGeoIp();
    return { ok: true, sizeBytes: statSync(dest).size, url };
  } catch (err) {
    return { ok: false, error: (err as Error).message, url };
  } finally {
    // Cleanup tmp dir (best-effort).
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Cari file .mmdb pertama dalam direktori (recursive). */
function findMmdb(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const sub = findMmdb(full);
      if (sub) return sub;
    } else if (entry.endsWith('.mmdb')) {
      return full;
    }
  }
  return null;
}
