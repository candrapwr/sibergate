import { type NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session-guarded proxy for the Custom Scripts endpoint:
 *   browser → /api/custom/<name> → gateway /api/custom/<name>
 *
 * Mirrors the /api/v1/* proxy: requires a valid login session, and injects a
 * client key (SIBERGATE_PLAYGROUND_KEY) when the caller carries no
 * Authorization header — so the route tester / mini-Postman can hit a script
 * endpoint without manually pasting an sg_live_* key. An explicit
 * Authorization header still wins (to test a specific key).
 *
 * The script endpoint is a real gateway path (/api/custom/*, not /v1/*), so we
 * forward the path verbatim — no prefix strip.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';
const PLAYGROUND_KEY = process.env.SIBERGATE_PLAYGROUND_KEY;
const SESSION_SECRET = process.env.SIBERGATE_SESSION_SECRET;
const SESSION_COOKIE = 'sibergate_session';

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
  // Gate behind a login session — same as /api/v1 and /api/admin proxies.
  const userId = verifySessionCookie(req.headers.get('cookie'));
  if (!userId) {
    return NextResponse.json(
      { error: { message: 'Not authenticated.', type: 'authentication_error' } },
      { status: 401 },
    );
  }

  const { path } = await ctx.params;
  // Forward verbatim to the gateway's /api/custom/* surface (real path, not a
  // /v1/* modality endpoint). Query string preserved.
  const target = `${GATEWAY}/api/custom/${path.join('/')}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  // Inject a CLIENT key (sg_live_*) only when the caller didn't supply their
  // own Authorization. The gateway /api/custom/* surface authenticates client
  // keys (same as /v1/*), NOT the admin key.
  if (!headers.has('authorization') && PLAYGROUND_KEY) {
    headers.set('Authorization', `Bearer ${PLAYGROUND_KEY}`);
  }

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
  } catch {
    return NextResponse.json(
      { error: { message: `Cannot reach gateway at ${GATEWAY}`, type: 'gateway_unreachable' } },
      { status: 502 },
    );
  }

  // The script's stdout may be any Content-Type (text, json, binary) and any
  // status; forward both verbatim.
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding'); // already decoded by fetch
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}
