import { type NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session-guarded proxy for the playground / route tester:
 * browser → /api/v1/<path> → gateway /v1/<path>.
 *
 * Unlike the open `/v1/*` proxy routes (which forward the client's sg_live_*
 * key verbatim and require it), THIS route requires a valid login session and
 * injects the admin key when the request carries no Authorization header — so
 * the playground / mini-Postman can run requests without asking the operator
 * for a client key. If the caller DOES supply an Authorization header (e.g. to
 * test a real client key), it is forwarded as-is and takes precedence.
 *
 * One catch-all serves every modality: chat, images, audio, embeddings, music,
 * generic — fixing the previous gap where embed/transcribe had no admin-side
 * proxy at all.
 */

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';
// IMPORTANT: gateway /v1/* authenticates CLIENT keys (sg_live_*, stored in the
// api_keys table), NOT the admin key. So the playground proxy must inject a
// client key here — the operator sets one via SIBERGATE_PLAYGROUND_KEY. The
// admin key would be rejected with 401 "Invalid API key".
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
  // Gate behind a login session — this proxy carries admin-key power.
  const userId = verifySessionCookie(req.headers.get('cookie'));
  if (!userId) {
    return NextResponse.json(
      { error: { message: 'Not authenticated.', type: 'authentication_error' } },
      { status: 401 },
    );
  }

  const { path } = await ctx.params;
  const target = `${GATEWAY}/v1/${path.join('/')}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  // Inject the playground CLIENT key (sg_live_*) only when the caller didn't
  // supply their own Authorization. The gateway /v1/* surface authenticates
  // client keys, not the admin key — so SIBERGATE_PLAYGROUND_KEY must be a
  // real client key created in the API Keys page. An explicit Authorization
  // header (e.g. to test a specific key) still wins.
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

  // Stream the body back verbatim (important for SSE chat streaming).
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding'); // already decoded by fetch
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}
