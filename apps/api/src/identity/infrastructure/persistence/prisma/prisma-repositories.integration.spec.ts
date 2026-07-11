import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PersistenceConflictError } from "../../../application/ports/persistence-error";
import { AuthenticationSession } from "../../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../../domain/authentication/token-family-id";
import { Organization } from "../../../domain/organization/organization";
import { OrganizationId } from "../../../domain/organization/organization-id";
import { OrganizationName } from "../../../domain/organization/organization-name";
import { OrganizationSetting } from "../../../domain/organization/organization-setting";
import { OrganizationSettingId } from "../../../domain/organization/organization-setting-id";
import { OrganizationSlug } from "../../../domain/organization/organization-slug";
import { Email } from "../../../domain/user/email";
import { PasswordHash } from "../../../domain/user/password-hash";
import { User } from "../../../domain/user/user";
import { UserId } from "../../../domain/user/user-id";
import { CryptoIdentifierGenerator } from "../../security/crypto-identifier-generator";
import { PrismaIdentityUnitOfWork } from "./prisma-identity-unit-of-work";
import { PrismaAuthenticationSessionRepository } from "./repositories/prisma-authentication-session.repository";
import { PrismaOrganizationRepository } from "./repositories/prisma-organization.repository";
import { PrismaOrganizationSettingRepository } from "./repositories/prisma-organization-setting.repository";
import { PrismaUserRepository } from "./repositories/prisma-user.repository";
import { PrismaService } from "../../../../infrastructure/prisma/prisma.service";

for (const candidate of [
  resolve(process.cwd(), ".env.test"),
  resolve(process.cwd(), "../../.env.test")
]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = testDatabaseUrl ? new URL(testDatabaseUrl).pathname.slice(1) : null;

if (testDatabaseUrl && databaseName !== "ai_workforce_os_test") {
  throw new Error("Integration tests refuse to run outside ai_workforce_os_test");
}

const integration = testDatabaseUrl ? describe : describe.skip;
const prisma = testDatabaseUrl ? new PrismaService({ datasourceUrl: testDatabaseUrl }) : null;
const identifiers = new CryptoIdentifierGenerator();

function client(): PrismaService {
  if (!prisma) {
    throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  }
  return prisma;
}

function organization(slug: string): Organization {
  return Organization.create(
    OrganizationId.from(identifiers.generate()),
    OrganizationName.create(`Organization ${slug}`),
    OrganizationSlug.create(slug)
  );
}

function organizationSetting(organizationId: Organization["id"], timezone = "UTC"): OrganizationSetting {
  return OrganizationSetting.create({
    id: OrganizationSettingId.from(identifiers.generate()),
    organizationId,
    timezone,
    currency: "USD",
    locale: "en-US"
  });
}

function owner(organizationId: Organization["id"], email: string): User {
  return User.registerOwner({
    id: UserId.from(identifiers.generate()),
    organizationId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: Email.create(email),
    passwordHash: PasswordHash.create("integration-test-password-hash")
  });
}

function familyId(): TokenFamilyId {
  return TokenFamilyId.from(identifiers.generate());
}

function session(userId: User["id"], tokenFamilyId = familyId()): AuthenticationSession {
  return AuthenticationSession.create({
    id: AuthenticationSessionId.from(identifiers.generate()),
    userId,
    tokenHash: `token-${identifiers.generate()}`,
    tokenFamilyId,
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  });
}

integration("Prisma identity repositories", () => {
  beforeAll(async () => {
    const result = await client().$queryRaw<Array<{ database: string }>>`
      SELECT current_database() AS database
    `;
    expect(result[0]?.database).toBe("ai_workforce_os_test");
  });

  beforeEach(async () => {
    await client().$transaction([
      client().authenticationSession.deleteMany(),
      client().user.deleteMany(),
      client().organizationSetting.deleteMany(),
      client().organization.deleteMany()
    ]);
  });

  it("saves and loads an organization", async () => {
    const repository = new PrismaOrganizationRepository(client());
    const expected = organization("save-load-organization");

    await repository.save(expected);
    const actual = await repository.findById(expected.id);

    expect(actual?.id.equals(expected.id)).toBe(true);
    expect(actual?.name.toString()).toBe(expected.name.toString());
    expect(actual?.slug.toString()).toBe(expected.slug.toString());
  });

  it("saves, loads, and updates organization settings", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const settings = new PrismaOrganizationSettingRepository(client());
    const parent = organization("settings-parent");
    const expected = organizationSetting(parent.id, "UTC");
    await organizations.save(parent);

    await settings.save(expected);
    const actual = await settings.findByOrganizationId(parent.id);

    expect(actual?.organizationId.equals(parent.id)).toBe(true);
    expect(actual?.timezone).toBe("UTC");

    expected.update({ timezone: "Europe/London", currency: "EUR", locale: "en-GB" });
    await settings.save(expected);
    const updated = await settings.findByOrganizationId(parent.id);

    expect(updated?.timezone).toBe("Europe/London");
    expect(updated?.currency).toBe("EUR");
    expect(updated?.locale).toBe("en-GB");
  });

  it("enforces unique organization slugs", async () => {
    const repository = new PrismaOrganizationRepository(client());
    await repository.save(organization("unique-organization"));

    await expect(repository.save(organization("unique-organization"))).rejects.toBeInstanceOf(
      PersistenceConflictError
    );
  });

  it("saves and loads a user", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const parent = organization("user-parent");
    const expected = owner(parent.id, "owner@example.com");
    await organizations.save(parent);

    await users.save(expected);
    const actual = await users.findById(expected.id);

    expect(actual?.id.equals(expected.id)).toBe(true);
    expect(actual?.organizationId.equals(parent.id)).toBe(true);
    expect(actual?.email.toString()).toBe("owner@example.com");
  });

  it("enforces unique normalized email addresses", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const parent = organization("email-parent");
    await organizations.save(parent);
    await users.save(owner(parent.id, "unique@example.com"));

    await expect(users.save(owner(parent.id, "UNIQUE@example.com"))).rejects.toBeInstanceOf(
      PersistenceConflictError
    );
  });

  it("saves and loads an authentication session", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const sessions = new PrismaAuthenticationSessionRepository(client());
    const parent = organization("session-parent");
    const account = owner(parent.id, "session@example.com");
    const expected = session(account.id);
    await organizations.save(parent);
    await users.save(account);

    await sessions.save(expected);
    const actual = await sessions.findById(expected.id);

    expect(actual?.id.equals(expected.id)).toBe(true);
    expect(actual?.userId.equals(account.id)).toBe(true);
    expect(actual?.tokenFamilyId.equals(expected.tokenFamilyId)).toBe(true);
  });

  it("revokes a session and records its replacement", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const sessions = new PrismaAuthenticationSessionRepository(client());
    const parent = organization("revoke-parent");
    const account = owner(parent.id, "revoke@example.com");
    const tokenFamilyId = familyId();
    const original = session(account.id, tokenFamilyId);
    const replacement = session(account.id, tokenFamilyId);
    await organizations.save(parent);
    await users.save(account);
    await sessions.save(original);
    await sessions.save(replacement);

    const revokedAt = new Date();
    await sessions.revoke(original.id, revokedAt, replacement.id);
    const actual = await sessions.findById(original.id);

    expect(actual?.isRevoked()).toBe(true);
    expect(actual?.replacedBySessionId?.equals(replacement.id)).toBe(true);
    expect(actual?.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it("revokes every active session in a token family", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const sessions = new PrismaAuthenticationSessionRepository(client());
    const parent = organization("family-parent");
    const account = owner(parent.id, "family@example.com");
    const tokenFamilyId = familyId();
    const first = session(account.id, tokenFamilyId);
    const second = session(account.id, tokenFamilyId);
    await organizations.save(parent);
    await users.save(account);
    await sessions.save(first);
    await sessions.save(second);

    const count = await sessions.revokeFamily(tokenFamilyId, new Date());

    expect(count).toBe(2);
    expect((await sessions.findById(first.id))?.isRevoked()).toBe(true);
    expect((await sessions.findById(second.id))?.isRevoked()).toBe(true);
  });

  it("atomically rotates a session and records replacement linkage", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const sessions = new PrismaAuthenticationSessionRepository(client());
    const parent = organization("atomic-rotation-parent");
    const account = owner(parent.id, "atomic-rotation@example.com");
    const original = session(account.id);
    const replacement = session(account.id, original.tokenFamilyId);
    await organizations.save(parent);
    await users.save(account);
    await sessions.save(original);

    const rotated = await sessions.rotate(
      original.id,
      original.tokenHashForPersistence(),
      replacement,
      new Date()
    );
    const persistedOriginal = await sessions.findById(original.id);

    expect(rotated).toBe(true);
    expect(persistedOriginal?.replacedBySessionId?.equals(replacement.id)).toBe(true);
    expect(await sessions.findById(replacement.id)).not.toBeNull();
  });

  it("atomically rotates once and rejects replay for the same session", async () => {
    const organizations = new PrismaOrganizationRepository(client());
    const users = new PrismaUserRepository(client());
    const sessions = new PrismaAuthenticationSessionRepository(client());
    const unitOfWork = new PrismaIdentityUnitOfWork(client());
    const parent = organization("concurrent-rotation-parent");
    const account = owner(parent.id, "concurrent-rotation@example.com");
    const original = session(account.id);
    const replacements = [
      session(account.id, original.tokenFamilyId),
      session(account.id, original.tokenFamilyId)
    ];
    await organizations.save(parent);
    await users.save(account);
    await sessions.save(original);

    const first = await unitOfWork.execute((repositories) =>
      repositories.sessions.rotate(
        original.id,
        original.tokenHashForPersistence(),
        replacements[0] as AuthenticationSession,
        new Date()
      )
    );
    const second = await unitOfWork.execute((repositories) =>
      repositories.sessions.rotate(
        original.id,
        original.tokenHashForPersistence(),
        replacements[1] as AuthenticationSession,
        new Date()
      )
    );

    expect([first, second].sort()).toEqual([false, true]);
    expect(
      await client().authenticationSession.count({
        where: { familyId: original.tokenFamilyId.toString() }
      })
    ).toBe(2);
  });

  it("rolls back every write when a unit of work fails", async () => {
    const unitOfWork = new PrismaIdentityUnitOfWork(client());
    const organizations = new PrismaOrganizationRepository(client());
    const rolledBack = organization("rolled-back-organization");

    await expect(
      unitOfWork.execute(async (repositories) => {
        await repositories.organizations.save(rolledBack);
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    expect(await organizations.findById(rolledBack.id)).toBeNull();
  });
});
