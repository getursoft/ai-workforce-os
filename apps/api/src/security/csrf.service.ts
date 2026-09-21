import { Injectable } from "@nestjs/common";

@Injectable()
export class CsrfService {
  private readonly cookieName = "csrf_token";

  generateToken(): string {
    return crypto.randomUUID();
  }

  getCookieName(): string {
    return this.cookieName;
  }

  validateToken(cookieValue: string | undefined, headerValue: string | undefined): boolean {
    if (!cookieValue || !headerValue) return false;
    return cookieValue === headerValue;
  }

  shouldProtect(request: { path: string; method: string }): boolean {
    const protectedMethods = ["POST", "PUT", "PATCH", "DELETE"];
    if (!protectedMethods.includes(request.method)) return false;
    const protectedPaths = ["/api/v1/auth/refresh", "/api/v1/auth/logout", "/api/v1/auth/change-password"];
    return protectedPaths.some((p) => request.path.startsWith(p));
  }
}
