import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";
import { REFRESH_TOKEN_COOKIE_NAME } from "./src/lib/auth-constants";

function createRequest(pathname: string, authenticated: boolean) {
  return {
    url: `http://localhost:3000${pathname}`,
    nextUrl: {
      pathname,
      search: ""
    },
    cookies: {
      has(name: string) {
        return authenticated && name === REFRESH_TOKEN_COOKIE_NAME;
      }
    }
  };
}

describe("dashboard middleware", () => {
  it("redirects unauthenticated users away from protected routes", () => {
    const response = middleware(createRequest("/dashboard", false) as never);
    expect(response.headers.get("location")).toContain("/login?returnUrl=%2Fdashboard");
  });

  it("redirects authenticated users away from the login page", () => {
    const response = middleware(createRequest("/login", true) as never);
    expect(response.headers.get("location")).toContain("/dashboard");
  });

  it("allows public routes through", () => {
    const response = middleware(createRequest("/", false) as never);
    expect(response.headers.get("location")).toBeNull();
  });
});
