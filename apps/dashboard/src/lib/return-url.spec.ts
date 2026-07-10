import { describe, expect, it } from "vitest";
import { buildLoginRedirectPath, isSafeInternalPath, resolveReturnUrl } from "./return-url";

describe("return-url helpers", () => {
  it("rejects unsafe external return URLs", () => {
    expect(isSafeInternalPath("https://evil.example.com")).toBe(false);
    expect(resolveReturnUrl("https://evil.example.com")).toBe("/dashboard");
    expect(buildLoginRedirectPath("https://evil.example.com")).toBe(
      "/login?returnUrl=%2Fdashboard"
    );
  });

  it("allows internal application paths", () => {
    expect(isSafeInternalPath("/dashboard/settings")).toBe(true);
    expect(resolveReturnUrl("/dashboard/settings")).toBe("/dashboard/settings");
  });
});
