import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sembunyikan badge "React DevTools" yg di-inject Next.js di pojok kanan-bawah
  // saat dev. Overlay itu sering nutup elemen fixed (sidebar/footer) dan tidak
  // ada gunanya di dashboard internal. Hanya affect dev (prod build tetap bersih).
  devIndicators: false,
  // The admin UI talks to the gateway via a server-side proxy route
  // (/api/admin/*), so no CORS or rewrites are needed here.

  // Pin the workspace root so Next.js doesn't get confused by stray
  // package-lock.json files in parent dirs (e.g. /home/ubuntu/). Without this,
  // Next.js may pick the wrong root (warning "multiple lockfiles") and then fail
  // to load packages/admin/.env.local — which makes SIBERGATE_GATEWAY_URL empty
  // and breaks the admin→gateway proxy (502 "Cannot reach gateway").
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
};

export default nextConfig;
