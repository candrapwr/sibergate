import { type NextRequest, NextResponse } from 'next/server';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

/** Proxy GET/DELETE /v1/videos/:id (status / delete job). */
async function proxy(req: NextRequest, id: string) {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  try {
    const upstream = await fetch(`${GATEWAY}/v1/videos/${encodeURIComponent(id)}`, {
      method: req.method,
      headers,
    });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('content-encoding');
    return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch {
    return NextResponse.json({ error: { message: `Cannot reach gateway`, type: 'gateway_unreachable' } }, { status: 502 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, (await params).id);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, (await params).id);
}
