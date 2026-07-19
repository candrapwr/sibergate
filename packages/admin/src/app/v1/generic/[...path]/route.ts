import { type NextRequest, NextResponse } from 'next/server';

/**
 * Proxy for the generic passthrough modality (route tester / playground):
 * browser → /v1/generic/<routeId>/... → gateway.
 *
 * Mirrors the per-modality proxy handlers but is a catch-all: it supports any
 * HTTP method and forwards the full path + query string + body verbatim. Like
 * the others, it forwards the client's sg_live_* key as-is (no admin key
 * injection) so this remains a real client call.
 */

const GATEWAY = process.env.SIBERGATE_GATEWAY_URL ?? 'http://localhost:8787';

async function proxy(req: NextRequest) {
  // Reconstruct the path after /v1/generic/ from the catch-all params.
  const segments = (req as unknown as { params: { path: string[] } }).params?.path ?? [];
  const suffix = segments.join('/');
  const target = `${GATEWAY}/v1/generic/${suffix}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      // GET/HEAD must not have a body.
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
    });
  } catch {
    return NextResponse.json(
      { error: { message: `Cannot reach gateway at ${GATEWAY}`, type: 'gateway_unreachable' } },
      { status: 502 },
    );
  }

  // Forward the upstream response (status, headers, body) verbatim — generic
  // passthrough must be transparent, including non-200 statuses and binary bodies.
  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding');
  return new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
