import { describe, expect, it } from "vitest";
import { InvalidRefreshTokenFormatError } from "../../application/errors/security.error";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { CryptoIdentifierGenerator } from "./crypto-identifier-generator";
import { HmacRefreshTokenService } from "./hmac-refresh-token-service";

const pepper = "refresh-token-test-pepper-with-at-least-32-bytes";
const identifiers = new CryptoIdentifierGenerator();

function sessionId(): AuthenticationSessionId {
  return AuthenticationSessionId.from(identifiers.generate());
}

describe("HmacRefreshTokenService", () => {
  it("generates unique session-bound tokens with 32 bytes of base64url randomness", () => {
    const service = new HmacRefreshTokenService(pepper);
    const id = sessionId();
    const first = service.generate(id);
    const second = service.generate(id);

    expect(first).toMatch(new RegExp(`^${id.toString()}\\.[A-Za-z0-9_-]{43}$`));
    expect(second).not.toBe(first);
  });

  it("parses and validates the session identifier", () => {
    const service = new HmacRefreshTokenService(pepper);
    const id = sessionId();

    expect(service.parse(service.generate(id)).sessionId.equals(id)).toBe(true);
  });

  it.each([
    "",
    "missing-dot",
    "too.many.parts",
    "not-a-uuid.abcdefghijklmnopqrstuvwxyzABCDEFG1234567890"
  ])("rejects malformed token %j", (rawToken) => {
    const service = new HmacRefreshTokenService(pepper);
    expect(() => service.parse(rawToken)).toThrow(InvalidRefreshTokenFormatError);
  });

  it("hashes deterministically and changes output with the pepper", () => {
    const rawToken = new HmacRefreshTokenService(pepper).generate(sessionId());
    const first = new HmacRefreshTokenService(pepper).hash(rawToken);
    const second = new HmacRefreshTokenService(pepper).hash(rawToken);
    const differentPepper = new HmacRefreshTokenService(`${pepper}-different`).hash(rawToken);

    expect(first).toBe(second);
    expect(differentPepper).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("verifies only the correct raw token", () => {
    const service = new HmacRefreshTokenService(pepper);
    const first = service.generate(sessionId());
    const second = service.generate(sessionId());
    const hash = service.hash(first);

    expect(service.verifyHash(first, hash)).toBe(true);
    expect(service.verifyHash(second, hash)).toBe(false);
  });

  it("fails safely for malformed stored hashes and raw tokens", () => {
    const service = new HmacRefreshTokenService(pepper);
    expect(service.verifyHash("malformed", "not-hex")).toBe(false);
    expect(service.verifyHash("malformed", "0".repeat(64))).toBe(false);
  });
});
