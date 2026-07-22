import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../types/auth";
import { bootstrapSession, finishInitialization } from "./auth-provider";

const current = {
  organization: { id: "org-1", name: "Org", slug: "org", status: "ACTIVE" },
  user: {
    id: "user-1",
    organizationId: "org-1",
    firstName: "Owner",
    email: "owner@example.test",
    role: "OWNER",
    status: "ACTIVE"
  }
};

describe("auth bootstrap", () => {
  it("resolves a valid current session", async () => {
    const me = vi.fn().mockResolvedValue(current);
    await expect(bootstrapSession({ me }, () => "access-token")).resolves.toMatchObject({
      ...current,
      accessToken: "access-token"
    });
    expect(me).toHaveBeenCalledOnce();
  });

  it("fails closed for unauthenticated, network, malformed, or unexpected bootstrap errors", async () => {
    for (const failure of [
      new Error("unauthenticated"),
      new TypeError("network unavailable"),
      new Error("malformed response"),
      new Error("unexpected bootstrap exception")
    ]) {
      await expect(
        bootstrapSession({ me: vi.fn().mockRejectedValue(failure) }, () => null)
      ).rejects.toBe(failure);
    }
  });

  it("always converts a loading state into a terminal state", () => {
    const loading: AuthState = {
      user: null,
      organization: null,
      accessToken: null,
      isAuthenticated: false,
      isInitializing: true
    };
    expect(finishInitialization(loading).isInitializing).toBe(false);
    expect(finishInitialization({ ...loading, isInitializing: false }).isInitializing).toBe(false);
  });
});
