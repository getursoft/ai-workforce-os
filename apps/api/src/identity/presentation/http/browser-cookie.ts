import type { IdentityRequest, IdentityResponse } from "./request-context";

export const REFRESH_TOKEN_COOKIE = "aiwos_refresh_token";

type SameSite = "lax" | "strict" | "none";

type CookieConfig = Readonly<{
  cookieDomain?: string;
  cookieSecure: boolean;
  cookieSameSite: SameSite;
}>;

function serializeCookie(
  name: string,
  value: string,
  config: CookieConfig,
  maxAgeSeconds?: number
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly"];
  if (config.cookieDomain) {
    parts.push(`Domain=${config.cookieDomain}`);
  }
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${config.cookieSameSite}`);
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.trunc(maxAgeSeconds)}`);
    parts.push(`Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`);
  }
  return parts.join("; ");
}

export function readRefreshTokenFromRequest(request: IdentityRequest): string | undefined {
  const header = request.header("cookie");
  if (!header) {
    return undefined;
  }
  const cookies = header.split(";").map((entry) => entry.trim());
  const entry = cookies.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE}=`));
  if (!entry) {
    return undefined;
  }
  const raw = entry.slice(REFRESH_TOKEN_COOKIE.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function setRefreshTokenCookie(
  response: IdentityResponse,
  refreshToken: string,
  config: CookieConfig,
  maxAgeSeconds: number
): void {
  response.setHeader("Set-Cookie", serializeCookie(REFRESH_TOKEN_COOKIE, refreshToken, config, maxAgeSeconds));
}

export function clearRefreshTokenCookie(response: IdentityResponse, config: CookieConfig): void {
  const parts = [`${REFRESH_TOKEN_COOKIE}=`, "Path=/", "HttpOnly", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (config.cookieDomain) {
    parts.push(`Domain=${config.cookieDomain}`);
  }
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${config.cookieSameSite}`);
  response.setHeader("Set-Cookie", parts.join("; "));
}
