import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'sibergate_session';
// Public paths that never require a session.
const PUBLIC_PATHS = ['/login', '/api/auth'];

/**
 * Gate the admin UI behind a login session.
 *
 * For every non-public route we require the session cookie to be present. The
 * real signature verification happens server-side (in the /api/admin/* and
 * /api/auth/me routes) — here we only do a fast presence check to avoid a
 * redirect loop and keep logged-out users out of the app shell.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Static assets and Next internals are always allowed.
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.includes('.')) {
    return NextResponse.next();
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (isPublic) return NextResponse.next();

  const hasSession = req.cookies.get(SESSION_COOKIE);
  if (!hasSession) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all paths except static assets, Next internals, and API routes
  // (API routes do their own session check in the proxy handler).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
