import { describe, expect, it } from "vitest";
import { OrganizationId } from "../organization/organization-id";
import { InvalidDomainValueError, InvalidEntityStateError } from "../shared/domain.error";
import { Email } from "./email";
import { PasswordHash } from "./password-hash";
import { UserId } from "./user-id";
import { UserRole } from "./user-role";
import { UserStatus } from "./user-status";
import { User } from "./user";

const createdAt = new Date("2026-07-10T10:00:00.000Z");
const organizationId = OrganizationId.from("00000000-0000-4000-8000-000000000001");
const passwordHash = PasswordHash.create("argon2-hash");

function reconstructWithStatus(status: UserStatus): User {
  return User.reconstruct({
    id: UserId.from("00000000-0000-4000-8000-000000000002"),
    organizationId,
    firstName: "Owner",
    email: Email.create("owner@example.com"),
    passwordHash,
    role: UserRole.OWNER,
    status,
    lastLoginAt: null,
    createdAt,
    updatedAt: createdAt
  });
}

describe("User", () => {
  it("registers an active owner belonging to an organization", () => {
    const user = User.registerOwner({
      id: UserId.from("00000000-0000-4000-8000-000000000002"),
      organizationId,
      firstName: "  Ada  ",
      lastName: "  Lovelace  ",
      email: Email.create("ada@example.com"),
      passwordHash,
      now: createdAt
    });

    expect(user.organizationId.equals(organizationId)).toBe(true);
    expect(user.firstName).toBe("Ada");
    expect(user.lastName).toBe("Lovelace");
    expect(user.role).toBe(UserRole.OWNER);
    expect(user.status).toBe(UserStatus.ACTIVE);
  });

  it.each([UserStatus.SUSPENDED, UserStatus.DISABLED])(
    "prevents %s users from authenticating",
    (status) => {
      const user = reconstructWithStatus(status);
      expect(user.canAuthenticate()).toBe(false);
      expect(() => user.recordLogin(new Date("2026-07-10T11:00:00.000Z"))).toThrow(
        InvalidEntityStateError
      );
    }
  );

  it("updates the last login through domain behavior", () => {
    const user = reconstructWithStatus(UserStatus.ACTIVE);
    const loginAt = new Date("2026-07-10T11:00:00.000Z");
    user.recordLogin(loginAt);
    expect(user.lastLoginAt).toEqual(loginAt);
    expect(user.updatedAt).toEqual(loginAt);
  });

  it("encapsulates the password hash", () => {
    const user = reconstructWithStatus(UserStatus.ACTIVE);
    expect(user.passwordHashMatches("argon2-hash")).toBe(true);
    expect(Object.keys(user)).not.toContain("passwordHash");
    expect(JSON.stringify(user)).not.toContain("argon2-hash");
  });

  it("rejects missing required reconstruction data", () => {
    expect(() =>
      User.reconstruct({
        id: UserId.from("00000000-0000-4000-8000-000000000002"),
        organizationId,
        firstName: " ",
        email: Email.create("owner@example.com"),
        passwordHash,
        role: UserRole.OWNER,
        status: UserStatus.ACTIVE,
        lastLoginAt: null,
        createdAt,
        updatedAt: createdAt
      })
    ).toThrow(InvalidDomainValueError);
  });

  it("rejects reconstruction without an organization", () => {
    expect(() =>
      User.reconstruct({
        id: UserId.from("00000000-0000-4000-8000-000000000002"),
        organizationId: undefined as unknown as OrganizationId,
        firstName: "Owner",
        email: Email.create("owner@example.com"),
        passwordHash,
        role: UserRole.OWNER,
        status: UserStatus.ACTIVE,
        lastLoginAt: null,
        createdAt,
        updatedAt: createdAt
      })
    ).toThrow("User must belong to an organization");
  });

  it("rejects invalid persisted identifiers", () => {
    expect(() => UserId.from("user-1")).toThrow(InvalidDomainValueError);
  });

  it("locks the account once failed attempts reach the threshold", () => {
    const user = reconstructWithStatus(UserStatus.ACTIVE);
    const at = new Date("2026-07-10T11:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      user.recordFailedLogin(5, 900, at);
      expect(user.isLockedOut(at)).toBe(false);
    }
    user.recordFailedLogin(5, 900, at);
    expect(user.failedLoginAttempts).toBe(5);
    expect(user.isLockedOut(at)).toBe(true);
    expect(user.lockedUntil).toEqual(new Date(at.getTime() + 900_000));
  });

  it("is no longer locked out once the lockout window elapses", () => {
    const user = reconstructWithStatus(UserStatus.ACTIVE);
    const at = new Date("2026-07-10T11:00:00.000Z");
    for (let i = 0; i < 5; i++) user.recordFailedLogin(5, 900, at);
    expect(user.isLockedOut(new Date(at.getTime() + 900_000 - 1))).toBe(true);
    expect(user.isLockedOut(new Date(at.getTime() + 900_001))).toBe(false);
  });

  it("clears lockout state on a successful login", () => {
    const user = reconstructWithStatus(UserStatus.ACTIVE);
    const at = new Date("2026-07-10T11:00:00.000Z");
    for (let i = 0; i < 5; i++) user.recordFailedLogin(5, 900, at);
    expect(user.isLockedOut(at)).toBe(true);
    user.recordLogin(new Date(at.getTime() + 1_000_000));
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(user.isLockedOut(new Date(at.getTime() + 1_000_000))).toBe(false);
  });
});
