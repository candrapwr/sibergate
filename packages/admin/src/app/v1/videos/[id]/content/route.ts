import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy GET /v1/videos/:id/content (stream mp4). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const upstream = await fetch(`${GATEWAY}/v1/videos/${encodeURIComponent(id)}/content`, {
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
