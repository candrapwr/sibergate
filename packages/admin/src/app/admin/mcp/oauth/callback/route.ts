import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/**
 * Proxy OAuth callback MCP: {public admin domain}/admin/mcp/oauth/callback →
 * gateway /admin/mcp/oauth/callback.
 *
 * URL ini adalah redirect_uri saat operator Connect provider MCP dari admin UI
 * yang di-host di domain publik (SiberGate public base di-auto-deteksi dari
 * Origin request Connect). TANPA session gate / admin key — redirect datang
 * dari server OAuth (bukan admin UI); flow dilindungi state + PKCE S256 di
 * gateway. Tanpa route ini domain admin membalas 404.
 */
export async function GET(req: NextRequest) {
  const target = `${GATEWAY}/admin/mcp/oauth/callback${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'GET', headers: { Accept: 'text/html,application/json' } });
  } catch {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui;background:#0b0f17;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:460px;padding:32px;text-align:center"><h1 style="font-size:18px">Callback Gagal</h1><p style="color:#9aa4b2;font-size:13px">Tidak bisa menghubungi gateway di ${GATEWAY}. Pastikan gateway berjalan dan SIBERGATE_GATEWAY_URL benar.</p></div></body></html>`,
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding');
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}
