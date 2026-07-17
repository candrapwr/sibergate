import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The admin UI talks to the gateway via a server-side proxy route
  // (/api/admin/*), so no CORS or rewrites are needed here.
};

export default nextConfig;
