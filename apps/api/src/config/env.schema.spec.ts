import { describe, expect, it } from "vitest";
import { DEFAULT_FIELDS, isProductionLike, validateEnvironment } from "./env.schema";

describe("env.schema", () => {
  it("no longer declares the dead fields removed in Sprint 5.0B (never read by any consumer)", () => {
    const names = DEFAULT_FIELDS.map((field) => field.name);
    expect(names).not.toContain("PUBLIC_API_URL");
    expect(names).not.toContain("DASHBOARD_URL");
    expect(names).not.toContain("TOKEN_ISSUER");
    expect(names).not.toContain("TOKEN_AUDIENCE");
  });

  it("declares the one real API_PUBLIC_URL field, required in production/staging", () => {
    const field = DEFAULT_FIELDS.find((item) => item.name === "API_PUBLIC_URL");
    expect(field).toMatchObject({ type: "url", requiredIn: ["production", "staging"] });
  });

  it("rejects a plain-HTTP URL in production with no localhost exemption", () => {
    const resolved = validateEnvironment(
      { APP_ENV: "production", API_PUBLIC_URL: "http://localhost:4000" },
      { productionLike: true }
    );
    expect(resolved.productionValid).toBe(false);
    expect(resolved.fields.API_PUBLIC_URL?.value).toBeNull();
  });

  it("accepts a plain-HTTP URL outside production/staging", () => {
    const resolved = validateEnvironment(
      { APP_ENV: "development", API_PUBLIC_URL: "http://localhost:4000" },
      { productionLike: false }
    );
    expect(resolved.fields.API_PUBLIC_URL?.value).toBe("http://localhost:4000/");
  });

  it("accepts a real https:// URL in production", () => {
    const resolved = validateEnvironment(
      { APP_ENV: "production", API_PUBLIC_URL: "https://api.example.com" },
      { productionLike: true }
    );
    expect(resolved.fields.API_PUBLIC_URL?.value).toBe("https://api.example.com/");
  });

  it("defaults the new knowledge/account-lockout fields when unset", () => {
    const resolved = validateEnvironment({}, { productionLike: false });
    expect(resolved.fields.ACCOUNT_LOCKOUT_MAX_ATTEMPTS?.value).toBe(5);
    expect(resolved.fields.ACCOUNT_LOCKOUT_DURATION_SECONDS?.value).toBe(900);
    expect(resolved.fields.KNOWLEDGE_MAX_FILE_SIZE_MB?.value).toBe(10);
    expect(resolved.fields.KNOWLEDGE_CHUNK_TARGET_TOKENS?.value).toBe(500);
    expect(resolved.fields.PLATFORM_OWNER_EMAIL?.value).toBe("krpandey25646@gmail.com");
  });

  it("isProductionLike prefers APP_ENV over NODE_ENV", () => {
    expect(isProductionLike({ APP_ENV: "development", NODE_ENV: "production" })).toBe(false);
    expect(isProductionLike({ APP_ENV: "production", NODE_ENV: "development" })).toBe(true);
    expect(isProductionLike({})).toBe(false);
  });
});
