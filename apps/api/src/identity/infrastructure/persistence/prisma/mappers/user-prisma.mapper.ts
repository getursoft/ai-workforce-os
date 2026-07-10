import {
  type User as PrismaUser,
  UserRole as PrismaUserRole,
  UserStatus as PrismaUserStatus
} from "@prisma/client";
import { OrganizationId } from "../../../../domain/organization/organization-id";
import { Email } from "../../../../domain/user/email";
import { PasswordHash } from "../../../../domain/user/password-hash";
import { User } from "../../../../domain/user/user";
import { UserId } from "../../../../domain/user/user-id";
import { UserRole } from "../../../../domain/user/user-role";
import { UserStatus } from "../../../../domain/user/user-status";

export class UserPrismaMapper {
  static toDomain(record: PrismaUser): User {
    const email = Email.create(record.normalizedEmail);
    return User.reconstruct({
      id: UserId.from(record.id),
      organizationId: OrganizationId.from(record.organizationId),
      firstName: record.firstName,
      ...(record.lastName === null ? {} : { lastName: record.lastName }),
      email,
      passwordHash: PasswordHash.create(record.passwordHash),
      role: this.toDomainRole(record.role),
      status: this.toDomainStatus(record.status),
      lastLoginAt: record.lastLoginAt ? new Date(record.lastLoginAt) : null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    });
  }

  static toPersistence(user: User): UserPersistence {
    return {
      id: user.id.toString(),
      organizationId: user.organizationId.toString(),
      firstName: user.firstName,
      lastName: user.lastName ?? null,
      email: user.email.toString(),
      normalizedEmail: user.email.toString(),
      passwordHash: user.passwordHashForPersistence(),
      role: this.toPrismaRole(user.role),
      status: this.toPrismaStatus(user.status),
      lastLoginAt: user.lastLoginAt,
      createdAt: new Date(user.createdAt),
      updatedAt: user.updatedAt
    };
  }

  private static toDomainRole(role: PrismaUserRole): UserRole {
    switch (role) {
      case PrismaUserRole.OWNER:
        return UserRole.OWNER;
      case PrismaUserRole.ADMIN:
        return UserRole.ADMIN;
      case PrismaUserRole.MEMBER:
        return UserRole.MEMBER;
    }
  }

  private static toPrismaRole(role: UserRole): PrismaUserRole {
    switch (role) {
      case UserRole.OWNER:
        return PrismaUserRole.OWNER;
      case UserRole.ADMIN:
        return PrismaUserRole.ADMIN;
      case UserRole.MEMBER:
        return PrismaUserRole.MEMBER;
    }
  }

  private static toDomainStatus(status: PrismaUserStatus): UserStatus {
    switch (status) {
      case PrismaUserStatus.ACTIVE:
        return UserStatus.ACTIVE;
      case PrismaUserStatus.INVITED:
        return UserStatus.INVITED;
      case PrismaUserStatus.SUSPENDED:
        return UserStatus.SUSPENDED;
      case PrismaUserStatus.DISABLED:
        return UserStatus.DISABLED;
    }
  }

  private static toPrismaStatus(status: UserStatus): PrismaUserStatus {
    switch (status) {
      case UserStatus.ACTIVE:
        return PrismaUserStatus.ACTIVE;
      case UserStatus.INVITED:
        return PrismaUserStatus.INVITED;
      case UserStatus.SUSPENDED:
        return PrismaUserStatus.SUSPENDED;
      case UserStatus.DISABLED:
        return PrismaUserStatus.DISABLED;
    }
  }
}

export interface UserPersistence {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  role: PrismaUserRole;
  status: PrismaUserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
