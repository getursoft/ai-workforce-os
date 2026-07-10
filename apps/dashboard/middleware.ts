import { NextResponse, type NextRequest } from "next/server";
import { REFRESH_TOKEN_COOKIE_NAME } from "./src/lib/auth-constants";
import { buildLoginRedirectPath } from "./src/lib/return-url";

const PROTECTED_PREFIXES = ["/dashboard", "/dashboard/"];
const AUTH_PREFIXES = ["/login"];

function hasRefreshCookie(request: NextRequest): boolean {
  return request.cookies.has(REFRESH_TOKEN_COOKIE_NAME);
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const authenticated = hasRefreshCookie(request);

  if (AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && authenticated) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && !authenticated) {
    return NextResponse.redirect(new URL(buildLoginRedirectPath(pathname + request.nextUrl.search), request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/login", "/dashboard/:path*", "/settings/:path*"]
};
