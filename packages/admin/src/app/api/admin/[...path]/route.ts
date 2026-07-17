import { type NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Server-side proxy: browser → /api/admin/<path> → gateway /admin/<path>.
 *
 * Requires a valid session cookie (the UI login gate). The admin key is then
 * injected here from server env, so it NEVER reaches the browser. Avoids CORS
 * and keeps the operator secret safe.
 */

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';
const ADMIN_KEY = process.env.SIBERGATE_ADMIN_KEY;
const SESSION_SECRET = process.env.SIBERGATE_SESSION_SECRET;
const SESSION_COOKIE = 'sibergate_session';

if (!ADMIN_KEY) {
  console.warn('[sibergate-admin] SIBERGATE_ADMIN_KEY is not set — admin API calls will 401.');
}

/** Verify the session cookie locally (HMAC, no DB hit). Returns userId or null. */
function verifySessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader || !SESSION_SECRET) return null;
  const m = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const token = m?.[1];
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
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
  // Require a valid login session before forwarding to the admin API.
  const userId = verifySessionCookie(req.headers.get('cookie'));
  if (!userId) {
    return NextResponse.json(
      { error: { message: 'Not authenticated.', type: 'authentication_error' } },
      { status: 401 },
    );
  }

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
