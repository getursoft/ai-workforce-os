import { describe, expect, it } from "vitest";
import { AuthenticationSession } from "../../../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../../../domain/authentication/token-family-id";
import { UserId } from "../../../../domain/user/user-id";
import { AuthenticationSessionPrismaMapper } from "./authentication-session-prisma.mapper";

const createdAt = new Date("2026-07-10T10:00:00.000Z");
const expiresAt = new Date("2026-07-11T10:00:00.000Z");
const revokedAt = new Date("2026-07-10T11:00:00.000Z");

describe("AuthenticationSessionPrismaMapper", () => {
  it("maps expiry, family, replacement, and nullable metadata to persistence", () => {
    const session = AuthenticationSession.reconstruct({
      id: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000003"),
      userId: UserId.from("00000000-0000-4000-8000-000000000002"),
      tokenHash: "token-hash",
      tokenFamilyId: TokenFamilyId.from("00000000-0000-4000-8000-000000000005"),
      expiresAt,
      revokedAt,
      replacedBySessionId: AuthenticationSessionId.from("00000000-0000-4000-8000-000000000004"),
      lastUsedAt: null,
      ipAddress: null,
      userAgent: null,
      createdAt
    });

    expect(AuthenticationSessionPrismaMapper.toPersistence(session)).toMatchObject({
      tokenHash: "token-hash",
      familyId: "00000000-0000-4000-8000-000000000005",
      expiresAt,
      revokedAt,
      replacedBySessionId: "00000000-0000-4000-8000-000000000004",
      lastUsedAt: null,
      ipAddress: null,
      userAgent: null
    });
  });

  it("reconstructs an unrevoked session and preserves its token family", () => {
    const session = AuthenticationSessionPrismaMapper.toDomain({
      id: "00000000-0000-4000-8000-000000000003",
      userId: "00000000-0000-4000-8000-000000000002",
      tokenHash: "token-hash",
      familyId: "00000000-0000-4000-8000-000000000005",
      expiresAt,
      revokedAt: null,
      replacedBySessionId: null,
      lastUsedAt: null,
      ipAddress: null,
      userAgent: null,
      createdAt
    });

    expect(session.isRevoked()).toBe(false);
    expect(session.replacedBySessionId).toBeNull();
    expect(session.expiresAt).toEqual(expiresAt);
    expect(session.tokenFamilyId.toString()).toBe("00000000-0000-4000-8000-000000000005");
  });
});
