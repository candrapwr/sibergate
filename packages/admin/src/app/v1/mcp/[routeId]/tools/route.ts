import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy GET /v1/mcp/:routeId/tools (list tools). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ routeId: string }> }) {
  const { routeId } = await params;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const upstream = await fetch(`${GATEWAY}/v1/mcp/${encodeURIComponent(routeId)}/tools`, {
      method: 'GET',
      headers,
    });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('content-encoding');
    return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch {
    return NextResponse.json({ error: { message: `Cannot reach gateway`, type: 'gateway_unreachable' } }, { status: 502 });
  }
}
