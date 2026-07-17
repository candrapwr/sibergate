import { NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy /api/auth/logout → gateway /auth/logout, clearing the cookie. */
export async function POST() {
  try {
    const upstream = await fetch(`${GATEWAY}/auth/logout`, { method: 'POST' });
    const setCookie = upstream.headers.get('set-cookie');
    const res = new NextResponse(await upstream.text(), { status: upstream.status });
    if (setCookie) res.headers.set('set-cookie', setCookie);
    return res;
  } catch {
    return NextResponse.json({ error: { message: 'Cannot reach gateway.', type: 'gateway_unreachable' } }, { status: 502 });
  }
}
