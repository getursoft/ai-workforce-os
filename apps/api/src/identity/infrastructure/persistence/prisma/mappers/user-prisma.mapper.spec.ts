import { UserRole as PrismaUserRole, UserStatus as PrismaUserStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { OrganizationId } from "../../../../domain/organization/organization-id";
import { Email } from "../../../../domain/user/email";
import { PasswordHash } from "../../../../domain/user/password-hash";
import { User } from "../../../../domain/user/user";
import { UserId } from "../../../../domain/user/user-id";
import { UserRole } from "../../../../domain/user/user-role";
import { UserStatus } from "../../../../domain/user/user-status";
import { UserPrismaMapper } from "./user-prisma.mapper";

const createdAt = new Date("2026-07-10T10:00:00.000Z");
const updatedAt = new Date("2026-07-10T11:00:00.000Z");

describe("UserPrismaMapper", () => {
  it("maps normalized email, role, status, nullable values, and controlled password hash", () => {
    const user = User.reconstruct({
      id: UserId.from("00000000-0000-4000-8000-000000000002"),
      organizationId: OrganizationId.from("00000000-0000-4000-8000-000000000001"),
      firstName: "Ada",
      email: Email.create("ADA@Example.com"),
      passwordHash: PasswordHash.create("argon2-hash"),
      role: UserRole.ADMIN,
      status: UserStatus.INVITED,
      lastLoginAt: null,
      createdAt,
      updatedAt
    });

    const record = UserPrismaMapper.toPersistence(user);
    expect(record).toMatchObject({
      email: "ada@example.com",
      normalizedEmail: "ada@example.com",
      lastName: null,
      lastLoginAt: null,
      passwordHash: "argon2-hash",
      role: PrismaUserRole.ADMIN,
      status: PrismaUserStatus.INVITED
    });
    expect(JSON.stringify(user)).not.toContain("argon2-hash");
    expect(Object.keys(user)).not.toContain("passwordHash");
  });

  it("reconstructs nullable and timestamp fields", () => {
    const user = UserPrismaMapper.toDomain({
      id: "00000000-0000-4000-8000-000000000002",
      organizationId: "00000000-0000-4000-8000-000000000001",
      firstName: "Ada",
      lastName: null,
      email: "Ada@Example.com",
      normalizedEmail: "ada@example.com",
      passwordHash: "argon2-hash",
      role: PrismaUserRole.OWNER,
      status: PrismaUserStatus.ACTIVE,
      lastLoginAt: null,
      createdAt,
      updatedAt
    });

    expect(user.email.toString()).toBe("ada@example.com");
    expect(user.lastName).toBeUndefined();
    expect(user.lastLoginAt).toBeNull();
    expect(user.role).toBe(UserRole.OWNER);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.updatedAt).toEqual(updatedAt);
  });
});
