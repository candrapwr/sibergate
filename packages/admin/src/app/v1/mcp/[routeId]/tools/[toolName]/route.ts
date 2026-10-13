import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy POST /v1/mcp/:routeId/tools/:toolName (call tool). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ routeId: string; toolName: string }> }) {
  const { routeId, toolName } = await params;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const upstream = await fetch(
      `${GATEWAY}/v1/mcp/${encodeURIComponent(routeId)}/tools/${encodeURIComponent(toolName)}`,
      { method: 'POST', headers, body: await req.text() },
    );
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('content-encoding');
    return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch {
    return NextResponse.json({ error: { message: `Cannot reach gateway`, type: 'gateway_unreachable' } }, { status: 502 });
  }
}
