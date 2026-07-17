import { type NextRequest, NextResponse } from 'next/server';

/**
 * Proxy for the playground: browser → /v1/chat/completions → gateway.
 *
 * Unlike the admin proxy, this does NOT inject any key — the client (sg_live_*)
 * key from the playground input is forwarded as-is. The gateway authenticates
 * it normally. This keeps the playground's client key out of CORS trouble and
 * avoids browser mixed-content issues, while remaining a real client call.
 */

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

export async function POST(req: NextRequest) {
  const target = `${GATEWAY}/v1/chat/completions`;

  // Pass through the client's Authorization header verbatim.
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: await req.text(),
    });
  } catch {
    return NextResponse.json(
      { error: { message: `Cannot reach gateway at ${GATEWAY}`, type: 'gateway_unreachable' } },
      { status: 502 },
    );
  }

  // Stream the body back verbatim (important for SSE).
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding');
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}
