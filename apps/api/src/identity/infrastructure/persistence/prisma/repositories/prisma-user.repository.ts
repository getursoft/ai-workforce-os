import type { UserRepository } from "../../../../application/ports/user-repository";
import type { Email } from "../../../../domain/user/email";
import type { User } from "../../../../domain/user/user";
import type { UserId } from "../../../../domain/user/user-id";
import type { IdentityPrismaClient } from "../identity-prisma-client";
import { UserPrismaMapper } from "../mappers/user-prisma.mapper";
import { translateKnownPrismaError } from "../prisma-error";

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly client: IdentityPrismaClient) {}

  async findById(id: UserId): Promise<User | null> {
    const record = await this.client.user.findUnique({ where: { id: id.toString() } });
    return record ? UserPrismaMapper.toDomain(record) : null;
  }

  async findByNormalizedEmail(email: Email): Promise<User | null> {
    const record = await this.client.user.findUnique({
      where: { normalizedEmail: email.toString() }
    });
    return record ? UserPrismaMapper.toDomain(record) : null;
  }

  async existsByNormalizedEmail(email: Email): Promise<boolean> {
    const count = await this.client.user.count({
      where: { normalizedEmail: email.toString() }
    });
    return count > 0;
  }

  async save(user: User): Promise<void> {
    const data = UserPrismaMapper.toPersistence(user);
    try {
      await this.client.user.upsert({
        where: { id: data.id },
        create: data,
        update: {
          organizationId: data.organizationId,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          normalizedEmail: data.normalizedEmail,
          passwordHash: data.passwordHash,
          role: data.role,
          status: data.status,
          lastLoginAt: data.lastLoginAt,
          updatedAt: data.updatedAt,
          failedLoginAttempts: data.failedLoginAttempts,
          lockedUntil: data.lockedUntil
        }
      });
    } catch (error: unknown) {
      translateKnownPrismaError(error);
    }
  }

  async updateLastLogin(id: UserId, lastLoginAt: Date): Promise<void> {
    await this.client.user.update({
      where: { id: id.toString() },
      data: {
        lastLoginAt: new Date(lastLoginAt),
        updatedAt: new Date(lastLoginAt),
        failedLoginAttempts: 0,
        lockedUntil: null
      }
    });
  }

  async recordFailedLogin(
    id: UserId,
    maxFailedAttempts: number,
    lockoutDurationSeconds: number,
    at: Date
  ): Promise<void> {
    const updated = await this.client.user.update({
      where: { id: id.toString() },
      data: { failedLoginAttempts: { increment: 1 }, updatedAt: new Date(at) },
      select: { failedLoginAttempts: true }
    });
    if (updated.failedLoginAttempts >= maxFailedAttempts) {
      await this.client.user.update({
        where: { id: id.toString() },
        data: { lockedUntil: new Date(at.getTime() + lockoutDurationSeconds * 1000) }
      });
    }
  }
}
