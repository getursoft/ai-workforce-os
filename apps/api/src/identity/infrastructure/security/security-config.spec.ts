import { describe, expect, it } from "vitest";
import { InvalidSecurityConfigurationError } from "../../application/errors/security.error";
import { loadSecurityConfig } from "./security-config";

function validEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: "test",
    JWT_ACCESS_SECRET: "jwt-test-secret-with-more-than-thirty-two-bytes",
    JWT_ACCESS_EXPIRES_IN_SECONDS: "900",
    JWT_ACCESS_ISSUER: "test-issuer",
    JWT_ACCESS_AUDIENCE: "test-audience",
    REFRESH_TOKEN_EXPIRES_IN_SECONDS: "2592000",
    REFRESH_TOKEN_PEPPER: "refresh-test-pepper-with-more-than-thirty-two-bytes",
    PASSWORD_HASH_MEMORY_COST: "8192",
    PASSWORD_HASH_TIME_COST: "1",
    PASSWORD_HASH_PARALLELISM: "1"
  };
}

describe("loadSecurityConfig", () => {
  it("loads and parses valid configuration", () => {
    const config = loadSecurityConfig(validEnvironment());

    expect(config.nodeEnvironment).toBe("test");
    expect(config.accessToken.expiresInSeconds).toBe(900);
    expect(config.refreshToken.expiresInSeconds).toBe(2_592_000);
    expect(config.passwordHash).toEqual({ memoryCost: 8192, timeCost: 1, parallelism: 1 });
  });

  it("rejects missing required secrets", () => {
    const environment = validEnvironment();
    environment.JWT_ACCESS_SECRET = undefined;

    expect(() => loadSecurityConfig(environment)).toThrow(InvalidSecurityConfigurationError);
  });

  it("rejects short secrets and peppers", () => {
    const shortSecret = validEnvironment();
    shortSecret.JWT_ACCESS_SECRET = "too-short";
    const shortPepper = validEnvironment();
    shortPepper.REFRESH_TOKEN_PEPPER = "too-short";

    expect(() => loadSecurityConfig(shortSecret)).toThrow(InvalidSecurityConfigurationError);
    expect(() => loadSecurityConfig(shortPepper)).toThrow(InvalidSecurityConfigurationError);
  });

  it.each([
    ["JWT_ACCESS_EXPIRES_IN_SECONDS", "abc"],
    ["REFRESH_TOKEN_EXPIRES_IN_SECONDS", "1.5"],
    ["PASSWORD_HASH_MEMORY_COST", "NaN"]
  ])("rejects invalid numeric value for %s", (variable, value) => {
    const environment = validEnvironment();
    environment[variable] = value;
    expect(() => loadSecurityConfig(environment)).toThrow(InvalidSecurityConfigurationError);
  });

  it.each([
    ["JWT_ACCESS_EXPIRES_IN_SECONDS", "0"],
    ["REFRESH_TOKEN_EXPIRES_IN_SECONDS", "-1"]
  ])("rejects non-positive expiry for %s", (variable, value) => {
    const environment = validEnvironment();
    environment[variable] = value;
    expect(() => loadSecurityConfig(environment)).toThrow(InvalidSecurityConfigurationError);
  });

  it.each([
    ["PASSWORD_HASH_MEMORY_COST", "8191"],
    ["PASSWORD_HASH_MEMORY_COST", "1048577"],
    ["PASSWORD_HASH_TIME_COST", "11"],
    ["PASSWORD_HASH_PARALLELISM", "17"]
  ])("rejects unsupported Argon2 range for %s", (variable, value) => {
    const environment = validEnvironment();
    environment[variable] = value;
    expect(() => loadSecurityConfig(environment)).toThrow(InvalidSecurityConfigurationError);
  });

  it("does not include secret values in configuration errors", () => {
    const environment = validEnvironment();
    const secret = "sensitive-short-value";
    environment.JWT_ACCESS_SECRET = secret;

    try {
      loadSecurityConfig(environment);
      throw new Error("Expected configuration validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidSecurityConfigurationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
