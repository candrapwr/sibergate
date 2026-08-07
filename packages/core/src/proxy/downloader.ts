/**
 * GeoLite2 mmdb downloader — download on-demand dari MaxMind (butuh license key
 * free). Dipicu manual via Settings → Update GeoIP DB.
 *
 * File disimpan ke geoipDbPath(). Setelah download, reloadGeoIp() re-load reader.
 * MaxMind mengemas DB sbg tar.gz berisi satu file mmdb + metadata; kita ekstrak
 * hanya file .mmdb via `tar`.
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
import { x as tarExtract } from 'tar';
import { geoipDbPath, reloadGeoIp } from './geoip.js';

export interface DownloadResult {
  ok: boolean;
  sizeBytes?: number;
  error?: string;
}

/**
 * Download GeoLite2-Country. MaxMind butuh license key (gratis, daftar di
 * maxmind.com). Set SIBERGATE_MAXMIND_LICENSE_KEY.
 */
export async function downloadGeoIpDb(): Promise<DownloadResult> {
  const licenseKey = process.env.SIBERGATE_MAXMIND_LICENSE_KEY;
  if (!licenseKey) {
    return {
      ok: false,
      error: 'SIBERGATE_MAXMIND_LICENSE_KEY not set. Register a free MaxMind account & set the license key.',
    };
  }
  const edition = 'GeoLite2-Country';
  const suffix = process.env.SIBERGATE_MAXMIND_DB_SUFFIX ?? '';
  const url = `https://download.maxmind.com/geoip/databases/${edition}/download?suffix=tar.gz${suffix}`;

  const dest = geoipDbPath();
  mkdirSync(dirname(dest), { recursive: true });

  const tmpDir = await mkdtemp(join(tmpdir(), 'sibergate-geoip-'));
  const tmpTar = join(tmpDir, 'geoip.tar.gz');

  try {
    // 1. Download tarball (basic auth dgn license key sbg username).
    const auth = Buffer.from(`${licenseKey}:`).toString('base64');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok || !res.body) {
      return { ok: false, error: `Download failed: HTTP ${res.status} ${res.statusText}` };
    }
    const ws = createWriteStream(tmpTar);
    const reader = res.body as unknown as NodeJS.ReadableStream;
    reader.on('data', (chunk) => ws.write(chunk));
    await new Promise<void>((resolveP, rejectP) => {
      reader.on('end', () => ws.end(resolveP));
      reader.on('error', rejectP);
      ws.on('error', rejectP);
    });

    // 2. Extract tar.gz → cari file .mmdb.
    await tarExtract({ file: tmpTar, cwd: tmpDir });
    const mmdbFile = findMmdb(tmpDir);
    if (!mmdbFile) {
      return { ok: false, error: 'No .mmdb file found in archive.' };
    }

    // 3. Pindahkan mmdb ke dest atomik.
    if (existsSync(dest)) unlinkSync(dest);
    renameSync(mmdbFile, dest);
    reloadGeoIp();
    return { ok: true, sizeBytes: statSync(dest).size };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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
