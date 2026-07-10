import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "./api-client";
import { ApiError, normalizeApiError, normalizeServerError } from "./api-error";

const authResponse = {
  organization: { id: "org-1", name: "Org", slug: "org", status: "ACTIVE" },
  user: {
    id: "user-1",
    organizationId: "org-1",
    firstName: "Krishna",
    lastName: "Pandey",
    email: "admin@getursoft.com",
    role: "OWNER",
    status: "ACTIVE"
  },
  tokens: {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 2_592_000
  }
};

describe("ApiClient", () => {
  const callbacks = {
    setSession: vi.fn(),
    clearSession: vi.fn(),
    getAccessToken: vi.fn(() => null)
  };

  beforeEach(() => {
    callbacks.setSession.mockReset();
    callbacks.clearSession.mockReset();
    callbacks.getAccessToken.mockReset().mockReturnValue(null);
    callbacks.setSession.mockImplementation(({ accessToken }) => {
      callbacks.getAccessToken.mockReturnValue(accessToken);
    });
    callbacks.clearSession.mockImplementation(() => {
      callbacks.getAccessToken.mockReturnValue(null);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes backend and transport errors", () => {
    const serverError = new Response(
      JSON.stringify({
        error: {
          code: "AUTHENTICATION_FAILED",
          message: "Invalid email or password.",
          details: [],
          requestId: "req-1",
          timestamp: "2026-07-10T00:00:00.000Z"
        }
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
    const normalizedServerError = normalizeServerError(serverError, {
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Invalid email or password.",
        details: [],
        requestId: "req-1",
        timestamp: "2026-07-10T00:00:00.000Z"
      }
    });
    const apiError = normalizeApiError(new TypeError("failed to fetch"));
    expect(apiError.kind).toBe("network");
    expect(normalizedServerError.code).toBe("AUTHENTICATION_FAILED");

    const clientError = new ApiError({
      kind: "authentication",
      code: "AUTHENTICATION_FAILED",
      message: "Invalid email or password."
    });
    expect(normalizeApiError(clientError)).toBe(clientError);
    expect(serverError.status).toBe(401);
  });

  it("deduplicates refresh requests while retrying concurrent 401 failures once", async () => {
    let protectedCallCount = 0;
    let refreshCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/refresh")) {
        refreshCallCount += 1;
        return new Response(JSON.stringify({ data: authResponse }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/protected")) {
        protectedCallCount += 1;
        if (protectedCallCount <= 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "Authentication is required.",
                details: [],
                requestId: "req-1",
                timestamp: "2026-07-10T00:00:00.000Z"
              }
            }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient(callbacks, "https://api.example.com/api/v1", 1_000);
    const results = await Promise.all([
      client.request<{ ok: boolean }>("/protected"),
      client.request<{ ok: boolean }>("/protected")
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCallCount).toBe(1);
    expect(callbacks.setSession).toHaveBeenCalledTimes(1);
  });

  it("clears auth state when refresh fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "INVALID_REFRESH_TOKEN",
              message: "Refresh token is invalid.",
              details: [],
              requestId: "req-1",
              timestamp: "2026-07-10T00:00:00.000Z"
            }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "AUTHENTICATION_FAILED",
            message: "Authentication is required.",
            details: [],
            requestId: "req-1",
            timestamp: "2026-07-10T00:00:00.000Z"
          }
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient(callbacks, "https://api.example.com/api/v1", 1_000);

    await expect(client.request("/protected")).rejects.toMatchObject({
      kind: "authentication"
    });
    expect(callbacks.clearSession).toHaveBeenCalledTimes(1);
  });

  it("aborts slow requests after the configured timeout", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          const abortError = () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal?.aborted) {
            abortError();
            return;
          }
          signal?.addEventListener("abort", abortError, { once: true });
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient(callbacks, "https://api.example.com/api/v1", 1);

    await expect(client.request("/protected")).rejects.toMatchObject({
      kind: "timeout"
    });
  });
});
