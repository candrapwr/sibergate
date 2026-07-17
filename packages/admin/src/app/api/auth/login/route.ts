import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy /api/auth/login → gateway /auth/login, forwarding the Set-Cookie. */
export async function POST(req: NextRequest) {
  try {
    const upstream = await fetch(`${GATEWAY}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await req.text(),
    });
    // Forward the Set-Cookie header so the browser stores the session.
    const setCookie = upstream.headers.get('set-cookie');
    const body = await upstream.text();
    const res = new NextResponse(body, { status: upstream.status });
    if (setCookie) res.headers.set('set-cookie', setCookie);
    return res;
  } catch {
    return NextResponse.json({ error: { message: 'Cannot reach gateway.', type: 'gateway_unreachable' } }, { status: 502 });
  }
}
