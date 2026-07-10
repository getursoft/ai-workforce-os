import type { AuthenticationSession as PrismaAuthenticationSession } from "@prisma/client";
import { AuthenticationSession } from "../../../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../../../domain/authentication/token-family-id";
import { UserId } from "../../../../domain/user/user-id";

export class AuthenticationSessionPrismaMapper {
  static toDomain(record: PrismaAuthenticationSession): AuthenticationSession {
    return AuthenticationSession.reconstruct({
      id: AuthenticationSessionId.from(record.id),
      userId: UserId.from(record.userId),
      tokenHash: record.tokenHash,
      tokenFamilyId: TokenFamilyId.from(record.familyId),
      expiresAt: new Date(record.expiresAt),
      revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
      replacedBySessionId: record.replacedBySessionId
        ? AuthenticationSessionId.from(record.replacedBySessionId)
        : null,
      lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null,
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      createdAt: new Date(record.createdAt)
    });
  }

  static toPersistence(session: AuthenticationSession): AuthenticationSessionPersistence {
    return {
      id: session.id.toString(),
      userId: session.userId.toString(),
      tokenHash: session.tokenHashForPersistence(),
      familyId: session.tokenFamilyId.toString(),
      expiresAt: new Date(session.expiresAt),
      revokedAt: session.revokedAt,
      replacedBySessionId: session.replacedBySessionId?.toString() ?? null,
      lastUsedAt: session.lastUsedAt ? new Date(session.lastUsedAt) : null,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: new Date(session.createdAt)
    };
  }
}

export interface AuthenticationSessionPersistence {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBySessionId: string | null;
  lastUsedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}
