import { OrganizationId } from "../organization/organization-id";
import { InvalidDomainValueError, InvalidEntityStateError } from "../shared/domain.error";
import {
  assertChronology,
  assertEnumValue,
  requireNonBlank,
  requireValidDate
} from "../shared/validation";
import type { Email } from "./email";
import type { PasswordHash } from "./password-hash";
import type { UserId } from "./user-id";
import { UserRole } from "./user-role";
import { UserStatus } from "./user-status";

export interface RegisterOwnerProperties {
  id: UserId;
  organizationId: OrganizationId;
  firstName: string;
  lastName?: string;
  email: Email;
  passwordHash: PasswordHash;
  now?: Date;
}

export interface ReconstructedUser {
  id: UserId;
  organizationId: OrganizationId;
  firstName: string;
  lastName?: string;
  email: Email;
  passwordHash: PasswordHash;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class User {
  readonly #passwordHash: PasswordHash;
  #lastLoginAt: Date | null;
  #updatedAt: Date;

  private constructor(
    readonly id: UserId,
    readonly organizationId: OrganizationId,
    readonly firstName: string,
    readonly lastName: string | undefined,
    readonly email: Email,
    passwordHash: PasswordHash,
    readonly role: UserRole,
    readonly status: UserStatus,
    lastLoginAt: Date | null,
    readonly createdAt: Date,
    updatedAt: Date
  ) {
    this.#passwordHash = passwordHash;
    this.#lastLoginAt = lastLoginAt;
    this.#updatedAt = updatedAt;
  }

  static registerOwner(properties: RegisterOwnerProperties): User {
    User.assertOrganization(properties.organizationId);
    const firstName = requireNonBlank(properties.firstName, "firstName");
    const lastName = User.normalizeLastName(properties.lastName);
    const createdAt = requireValidDate(properties.now ?? new Date(), "createdAt");
    return new User(
      properties.id,
      properties.organizationId,
      firstName,
      lastName,
      properties.email,
      properties.passwordHash,
      UserRole.OWNER,
      UserStatus.ACTIVE,
      null,
      createdAt,
      new Date(createdAt)
    );
  }

  static reconstruct(properties: ReconstructedUser): User {
    User.assertOrganization(properties.organizationId);
    assertEnumValue(Object.values(UserRole), properties.role, "userRole");
    assertEnumValue(Object.values(UserStatus), properties.status, "userStatus");
    const firstName = requireNonBlank(properties.firstName, "firstName");
    const lastName = User.normalizeLastName(properties.lastName);
    const createdAt = requireValidDate(properties.createdAt, "createdAt");
    const updatedAt = requireValidDate(properties.updatedAt, "updatedAt");
    assertChronology("User", createdAt, updatedAt, "updatedAt cannot precede createdAt");
    const lastLoginAt = properties.lastLoginAt
      ? requireValidDate(properties.lastLoginAt, "lastLoginAt")
      : null;
    if (lastLoginAt && lastLoginAt.getTime() < createdAt.getTime()) {
      throw new InvalidEntityStateError("User", "lastLoginAt cannot precede createdAt");
    }
    return new User(
      properties.id,
      properties.organizationId,
      firstName,
      lastName,
      properties.email,
      properties.passwordHash,
      properties.role,
      properties.status,
      lastLoginAt,
      createdAt,
      updatedAt
    );
  }

  get lastLoginAt(): Date | null {
    return this.#lastLoginAt ? new Date(this.#lastLoginAt) : null;
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  canAuthenticate(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  recordLogin(at = new Date()): void {
    if (!this.canAuthenticate()) {
      throw new InvalidEntityStateError("User", "Inactive users cannot authenticate");
    }
    const loginAt = requireValidDate(at, "lastLoginAt");
    if (loginAt.getTime() < this.createdAt.getTime()) {
      throw new InvalidEntityStateError("User", "lastLoginAt cannot precede createdAt");
    }
    this.#lastLoginAt = loginAt;
    this.#updatedAt = new Date(loginAt);
  }

  passwordHashMatches(value: string): boolean {
    return this.#passwordHash.matches(value);
  }

  passwordHashForPersistence(): string {
    return this.#passwordHash.persistenceValue();
  }

  private static normalizeLastName(lastName: string | undefined): string | undefined {
    if (lastName === undefined) {
      return undefined;
    }
    const normalized = lastName.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private static assertOrganization(organizationId: OrganizationId): void {
    if (!(organizationId instanceof OrganizationId)) {
      throw new InvalidDomainValueError("organizationId", "User must belong to an organization");
    }
  }
}
