import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/**
 * Proxy /api/auth/me → gateway /auth/me. Forwards the browser's cookie
 * so the gateway can resolve the current session. Returns 401 if not logged in.
 */
export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') ?? '';
  try {
    const upstream = await fetch(`${GATEWAY}/auth/me`, {
      headers: cookie ? { cookie } : {},
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: { message: 'Cannot reach gateway.', type: 'gateway_unreachable' } }, { status: 502 });
  }
}
