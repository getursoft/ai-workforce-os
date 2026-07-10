import type { AuthenticationSessionRepository } from "../../../../application/ports/authentication-session-repository";
import type { AuthenticationSession } from "../../../../domain/authentication/authentication-session";
import type { AuthenticationSessionId } from "../../../../domain/authentication/authentication-session-id";
import type { TokenFamilyId } from "../../../../domain/authentication/token-family-id";
import type { IdentityPrismaClient } from "../identity-prisma-client";
import { AuthenticationSessionPrismaMapper } from "../mappers/authentication-session-prisma.mapper";
import { translateKnownPrismaError } from "../prisma-error";

export class PrismaAuthenticationSessionRepository implements AuthenticationSessionRepository {
  constructor(private readonly client: IdentityPrismaClient) {}

  async findById(id: AuthenticationSessionId): Promise<AuthenticationSession | null> {
    const record = await this.client.authenticationSession.findUnique({
      where: { id: id.toString() }
    });
    return record ? AuthenticationSessionPrismaMapper.toDomain(record) : null;
  }

  async save(session: AuthenticationSession): Promise<void> {
    const data = AuthenticationSessionPrismaMapper.toPersistence(session);
    try {
      await this.client.authenticationSession.upsert({
        where: { id: data.id },
        create: data,
        update: {
          userId: data.userId,
          tokenHash: data.tokenHash,
          familyId: data.familyId,
          expiresAt: data.expiresAt,
          revokedAt: data.revokedAt,
          replacedBySessionId: data.replacedBySessionId,
          lastUsedAt: data.lastUsedAt,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent
        }
      });
    } catch (error: unknown) {
      translateKnownPrismaError(error);
    }
  }

  async revoke(
    id: AuthenticationSessionId,
    revokedAt: Date,
    replacedBySessionId: AuthenticationSessionId | null
  ): Promise<void> {
    await this.client.authenticationSession.update({
      where: { id: id.toString() },
      data: {
        revokedAt: new Date(revokedAt),
        replacedBySessionId: replacedBySessionId?.toString() ?? null
      }
    });
  }

  async revokeFamily(familyId: TokenFamilyId, revokedAt: Date): Promise<number> {
    const result = await this.client.authenticationSession.updateMany({
      where: { familyId: familyId.toString(), revokedAt: null },
      data: { revokedAt: new Date(revokedAt) }
    });
    return result.count;
  }

  async rotate(
    currentId: AuthenticationSessionId,
    expectedTokenHash: string,
    replacement: AuthenticationSession,
    revokedAt: Date
  ): Promise<boolean> {
    const replacementData = AuthenticationSessionPrismaMapper.toPersistence(replacement);
    try {
      await this.client.authenticationSession.create({ data: replacementData });
      const result = await this.client.authenticationSession.updateMany({
        where: {
          id: currentId.toString(),
          tokenHash: expectedTokenHash,
          revokedAt: null,
          replacedBySessionId: null
        },
        data: {
          revokedAt: new Date(revokedAt),
          replacedBySessionId: replacementData.id
        }
      });
      if (result.count === 0) {
        await this.client.authenticationSession.delete({ where: { id: replacementData.id } });
        return false;
      }
      return true;
    } catch (error: unknown) {
      translateKnownPrismaError(error);
    }
  }
}
