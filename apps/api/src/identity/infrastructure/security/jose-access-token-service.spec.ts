import { describe, expect, it } from "vitest";
import {
  ExpiredAccessTokenError,
  InvalidAccessTokenError
} from "../../application/errors/security.error";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import type { Clock } from "../../application/ports/clock";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { OrganizationId } from "../../domain/organization/organization-id";
import { UserId } from "../../domain/user/user-id";
import { UserRole } from "../../domain/user/user-role";
import { CryptoIdentifierGenerator } from "./crypto-identifier-generator";
import { JoseAccessTokenService } from "./jose-access-token-service";
import type { SecurityConfig } from "./security-config";

type AccessTokenConfig = SecurityConfig["accessToken"];

class FixedClock implements Clock {
  constructor(private currentTime: Date) {}

  now(): Date {
    return new Date(this.currentTime);
  }

  set(time: Date): void {
    this.currentTime = new Date(time);
  }
}

const issuedAt = new Date("2026-07-10T12:00:00.000Z");
const config: AccessTokenConfig = {
  secret: "jwt-access-token-test-secret-with-at-least-32-bytes",
  expiresInSeconds: 900,
  issuer: "test-issuer",
  audience: "test-audience"
};
const identifiers = new CryptoIdentifierGenerator();

function principal(): AuthenticatedPrincipal {
  return {
    userId: UserId.from(identifiers.generate()),
    organizationId: OrganizationId.from(identifiers.generate()),
    role: UserRole.ADMIN,
    sessionId: AuthenticationSessionId.from(identifiers.generate())
  };
}

async function customToken(
  claims: Record<string, unknown>,
  overrides: Partial<AccessTokenConfig> = {}
): Promise<string> {
  const options = { ...config, ...overrides };
  const { SignJWT } = await import("jose");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .sign(new TextEncoder().encode(options.secret));
}

function validClaims(subject: AuthenticatedPrincipal): Record<string, unknown> {
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
  return {
    sub: subject.userId.toString(),
    org: subject.organizationId.toString(),
    role: subject.role,
    sid: subject.sessionId.toString(),
    type: "access",
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + config.expiresInSeconds
  };
}

describe("JoseAccessTokenService", () => {
  it("issues a signed access token with every required claim", async () => {
    const service = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const subject = principal();
    const token = await service.issue(subject, issuedAt);
    const { jwtVerify } = await import("jose");
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(config.secret),
      {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["HS256"],
        currentDate: issuedAt
      }
    );

    expect(protectedHeader.alg).toBe("HS256");
    expect(payload).toMatchObject(validClaims(subject));
    expect(payload.iss).toBe(config.issuer);
    expect(payload.aud).toBe(config.audience);
  });

  it("verifies a token and returns only an authenticated principal", async () => {
    const service = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const expected = principal();
    const actual = await service.verify(await service.issue(expected, issuedAt));

    expect(actual.userId.equals(expected.userId)).toBe(true);
    expect(actual.organizationId.equals(expected.organizationId)).toBe(true);
    expect(actual.sessionId.equals(expected.sessionId)).toBe(true);
    expect(actual.role).toBe(expected.role);
    expect(Object.keys(actual).sort()).toEqual(["organizationId", "role", "sessionId", "userId"]);
  });

  it("rejects an invalid signature", async () => {
    const verifier = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const signer = new JoseAccessTokenService(
      { ...config, secret: "different-signing-secret-with-at-least-thirty-two-bytes" },
      new FixedClock(issuedAt)
    );

    await expect(verifier.verify(await signer.issue(principal(), issuedAt))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });

  it("rejects an expired token using controlled time", async () => {
    const clock = new FixedClock(issuedAt);
    const service = new JoseAccessTokenService(config, clock);
    const token = await service.issue(principal(), issuedAt);
    clock.set(new Date(issuedAt.getTime() + 901_000));

    await expect(service.verify(token)).rejects.toBeInstanceOf(ExpiredAccessTokenError);
  });

  it("rejects the wrong issuer", async () => {
    const verifier = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const signer = new JoseAccessTokenService(
      { ...config, issuer: "wrong-issuer" },
      new FixedClock(issuedAt)
    );

    await expect(verifier.verify(await signer.issue(principal(), issuedAt))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });

  it("rejects the wrong audience", async () => {
    const verifier = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const signer = new JoseAccessTokenService(
      { ...config, audience: "wrong-audience" },
      new FixedClock(issuedAt)
    );

    await expect(verifier.verify(await signer.issue(principal(), issuedAt))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });

  it("rejects a token with the wrong type", async () => {
    const service = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const claims = validClaims(principal());
    claims.type = "refresh";

    await expect(service.verify(await customToken(claims))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });

  it("rejects a token missing a required claim", async () => {
    const service = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const claims = validClaims(principal());
    delete claims.org;

    await expect(service.verify(await customToken(claims))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });

  it.each([
    ["sub", 123],
    ["org", 123],
    ["role", 123],
    ["sid", 123],
    ["iat", "not-a-number"],
    ["exp", "not-a-number"]
  ])("rejects malformed %s claim types", async (claim, value) => {
    const service = new JoseAccessTokenService(config, new FixedClock(issuedAt));
    const claims = validClaims(principal());
    claims[claim] = value;

    await expect(service.verify(await customToken(claims))).rejects.toBeInstanceOf(
      InvalidAccessTokenError
    );
  });
});
