import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "../../next.config";

describe("dashboard content security policy", () => {
  it("allows only required data fonts and local data/blob images", () => {
    const policy = buildContentSecurityPolicy("production", "https://api.example.test/api/v1");
    expect(policy).toContain("font-src 'self' data:");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("connect-src 'self' https://api.example.test");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain("*");
  });

  it("allows the local API and Next source-mapped runtime only in development", () => {
    const policy = buildContentSecurityPolicy("development", "http://localhost:4000/api/v1");
    expect(policy).toContain("connect-src 'self' http://localhost:4000");
    expect(policy).toContain("'unsafe-eval'");
  });
});
