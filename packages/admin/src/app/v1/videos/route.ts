import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy POST /v1/videos (create job) — dipakai playground/route-tester admin. */
export async function POST(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const upstream = await fetch(`${GATEWAY}/v1/videos`, {
      method: 'POST',
      headers,
      body: await req.text(),
    });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('content-encoding');
    return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch {
    return NextResponse.json({ error: { message: `Cannot reach gateway`, type: 'gateway_unreachable' } }, { status: 502 });
  }
}
