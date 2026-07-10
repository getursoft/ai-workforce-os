import { describe, expect, it } from "vitest";
import { InvalidEntityStateError, InvalidStateTransitionError } from "../shared/domain.error";
import { UserId } from "../user/user-id";
import { AuthenticationSessionId } from "./authentication-session-id";
import { AuthenticationSession } from "./authentication-session";
import { TokenFamilyId } from "./token-family-id";

const createdAt = new Date("2026-07-10T10:00:00.000Z");
const expiresAt = new Date("2026-07-10T11:00:00.000Z");

function createSession(): AuthenticationSession {
  return AuthenticationSession.create({
    id: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000003"),
    userId: UserId.from("00000000-0000-4000-8000-000000000002"),
    tokenHash: "token-hash",
    tokenFamilyId: TokenFamilyId.from("00000000-0000-4000-8000-000000000005"),
    expiresAt,
    now: createdAt
  });
}

describe("AuthenticationSession", () => {
  it("identifies expiry at and after its expiry time", () => {
    const session = createSession();
    expect(session.isExpired(new Date("2026-07-10T10:59:59.999Z"))).toBe(false);
    expect(session.isExpired(expiresAt)).toBe(true);
  });

  it("can be revoked once while active", () => {
    const session = createSession();
    const revokedAt = new Date("2026-07-10T10:30:00.000Z");
    session.revoke(revokedAt);
    expect(session.isRevoked()).toBe(true);
    expect(session.revokedAt).toEqual(revokedAt);
    expect(() => session.revoke(revokedAt)).toThrow(InvalidStateTransitionError);
  });

  it("records a replacement and atomically marks the old session revoked", () => {
    const session = createSession();
    const replacementId = AuthenticationSessionId.from("00000000-0000-4000-8000-000000000004");
    session.replaceWith(replacementId, new Date("2026-07-10T10:30:00.000Z"));
    expect(session.isRotated()).toBe(true);
    expect(session.isRevoked()).toBe(true);
    expect(session.replacedBySessionId?.equals(replacementId)).toBe(true);
  });

  it("rejects invalid reconstruction data", () => {
    expect(() =>
      AuthenticationSession.reconstruct({
        id: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000003"),
        userId: UserId.from("00000000-0000-4000-8000-000000000002"),
        tokenHash: "token-hash",
        tokenFamilyId: TokenFamilyId.from("00000000-0000-4000-8000-000000000005"),
        createdAt,
        expiresAt: new Date("2026-07-10T09:00:00.000Z"),
        revokedAt: null,
        replacedBySessionId: null,
        lastUsedAt: null,
        ipAddress: null,
        userAgent: null
      })
    ).toThrow(InvalidEntityStateError);
  });

  it("rejects a reconstructed replacement without revocation", () => {
    expect(() =>
      AuthenticationSession.reconstruct({
        id: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000003"),
        userId: UserId.from("00000000-0000-4000-8000-000000000002"),
        tokenHash: "token-hash",
        tokenFamilyId: TokenFamilyId.from("00000000-0000-4000-8000-000000000005"),
        createdAt,
        expiresAt,
        revokedAt: null,
        replacedBySessionId: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000004"),
        lastUsedAt: null,
        ipAddress: null,
        userAgent: null
      })
    ).toThrow(InvalidEntityStateError);
  });

  it("rejects invalid persisted identifiers", () => {
    expect(() => AuthenticationSessionId.from("session-1")).toThrow();
    expect(() => TokenFamilyId.from("family-1")).toThrow();
  });
});
