import { type NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy: browser → /api/admin/<path> → gateway /admin/<path>.
 *
 * The admin key is injected here from server env, so it NEVER reaches the
 * browser. This avoids CORS entirely and keeps the operator secret safe.
 *
 * Supports all methods (GET/POST/PATCH/PUT/DELETE) and forwards the body,
 * query string, and relevant headers. Gateway responses are streamed back
 * verbatim.
 */

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';
const ADMIN_KEY = process.env.SIBERGATE_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.warn('[sibergate-admin] SIBERGATE_ADMIN_KEY is not set — admin API calls will 401.');
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx);
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${GATEWAY}/admin/${path.join('/')}${req.nextUrl.search}`;

  // Forward headers, but drop hop-by-hop and host so fetch can set them.
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.set('Authorization', `Bearer ${ADMIN_KEY ?? ''}`);

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return NextResponse.json(
      { error: { message: `Cannot reach gateway at ${GATEWAY}`, type: 'gateway_unreachable' } },
      { status: 502 },
    );
  }

  // Stream the body back verbatim.
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding'); // already decoded by fetch
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}
