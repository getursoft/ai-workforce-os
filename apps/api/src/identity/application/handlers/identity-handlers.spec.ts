import { describe, expect, it } from "vitest";
import type { AccessTokenService } from "../ports/access-token-service";
import type { AuthenticationLifetimes } from "../ports/authentication-lifetimes";
import type { AuthenticationSessionRepository } from "../ports/authentication-session-repository";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { Clock } from "../ports/clock";
import type { IdentifierGenerator } from "../ports/identifier-generator";
import type { IdentityRepositories, IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { OrganizationSettingRepository } from "../ports/organization-setting-repository";
import type { PasswordHasher } from "../ports/password-hasher";
import type { RefreshTokenService } from "../ports/refresh-token-service";
import type { UserRepository } from "../ports/user-repository";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { InvalidRefreshTokenFormatError } from "../errors/security.error";
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import type { TokenFamilyId } from "../../domain/authentication/token-family-id";
import { Organization } from "../../domain/organization/organization";
import { OrganizationId } from "../../domain/organization/organization-id";
import type { OrganizationSetting } from "../../domain/organization/organization-setting";
import type { OrganizationSlug } from "../../domain/organization/organization-slug";
import { OrganizationStatus } from "../../domain/organization/organization-status";
import type { Email } from "../../domain/user/email";
import { PasswordHash } from "../../domain/user/password-hash";
import { User } from "../../domain/user/user";
import type { UserId } from "../../domain/user/user-id";
import { UserStatus } from "../../domain/user/user-status";
import { GetCurrentUserHandler } from "./get-current-user";
import { GetOrganizationHandler } from "./get-organization";
import { GetOrganizationSettingsHandler } from "./get-organization-settings";
import { LoginHandler } from "./login";
import { LogoutHandler } from "./logout";
import { RefreshSessionHandler } from "./refresh-session";
import { RegisterOrganizationHandler } from "./register-organization";
import { UpdateOrganizationHandler } from "./update-organization";
import { UpdateOrganizationSettingsHandler } from "./update-organization-settings";

const now = new Date("2026-07-10T12:00:00.000Z");
const lifetimes: AuthenticationLifetimes = {
  accessTokenExpiresInSeconds: 900,
  refreshTokenExpiresInSeconds: 2_592_000
};

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequentialIdentifiers implements IdentifierGenerator {
  private value = 1;

  generate(): string {
    const suffix = this.value.toString(16).padStart(12, "0");
    this.value += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

class FakePasswordHasher implements PasswordHasher {
  hashCalls = 0;

  hash(plainPassword: string): Promise<string> {
    this.hashCalls += 1;
    return Promise.resolve(`hashed:${plainPassword}`);
  }

  verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    return Promise.resolve(passwordHash === `hashed:${plainPassword}`);
  }
}

class FakeAccessTokens implements AccessTokenService {
  issue(principal: AuthenticatedPrincipal): Promise<string> {
    return Promise.resolve(`access:${principal.sessionId.toString()}`);
  }

  verify(): Promise<AuthenticatedPrincipal> {
    return Promise.reject(new Error("not used"));
  }
}

class FakeRefreshTokens implements RefreshTokenService {
  generate(sessionId: AuthenticationSessionId): string {
    return `${sessionId.toString()}.${"A".repeat(43)}`;
  }

  parse(rawToken: string): { sessionId: AuthenticationSessionId } {
    const [id, secret, extra] = rawToken.split(".");
    if (!id || !secret || extra || secret.length !== 43) {
      throw new InvalidRefreshTokenFormatError();
    }
    try {
      return { sessionId: AuthenticationSessionId.from(id) };
    } catch {
      throw new InvalidRefreshTokenFormatError();
    }
  }

  hash(rawToken: string): string {
    return `hash:${rawToken}`;
  }

  verifyHash(rawToken: string, storedHash: string): boolean {
    return storedHash === this.hash(rawToken);
  }
}

class MemoryStore {
  organizations: Organization[] = [];
  organizationSettings: OrganizationSetting[] = [];
  users: User[] = [];
  sessions: AuthenticationSession[] = [];
  failSessionSave = false;
  transactions = 0;
}

class MemoryOrganizations implements OrganizationRepository {
  constructor(private readonly store: MemoryStore) {}
  findById(id: OrganizationId): Promise<Organization | null> {
    return Promise.resolve(this.store.organizations.find((item) => item.id.equals(id)) ?? null);
  }
  findBySlug(slug: OrganizationSlug): Promise<Organization | null> {
    return Promise.resolve(
      this.store.organizations.find((item) => item.slug.toString() === slug.toString()) ?? null
    );
  }
  findByName(name: string): Promise<Organization | null> {
    const normalized = name.trim().toLowerCase();
    return Promise.resolve(
      this.store.organizations.find(
        (item) =>
          item.name.toString().toLowerCase() === normalized ||
          item.slug.toString().toLowerCase() === normalized
      ) ?? null
    );
  }
  existsBySlug(slug: OrganizationSlug): Promise<boolean> {
    return Promise.resolve(
      this.store.organizations.some((item) => item.slug.toString() === slug.toString())
    );
  }
  save(organization: Organization): Promise<void> {
    this.store.organizations.push(organization);
    return Promise.resolve();
  }
}

class MemoryOrganizationSettings implements OrganizationSettingRepository {
  constructor(private readonly store: MemoryStore) {}
  findByOrganizationId(organizationId: OrganizationId): Promise<OrganizationSetting | null> {
    return Promise.resolve(
      this.store.organizationSettings.find((item) => item.organizationId.equals(organizationId)) ??
        null
    );
  }
  save(setting: OrganizationSetting): Promise<void> {
    const index = this.store.organizationSettings.findIndex((item) =>
      item.organizationId.equals(setting.organizationId)
    );
    if (index >= 0) {
      this.store.organizationSettings[index] = setting;
    } else {
      this.store.organizationSettings.push(setting);
    }
    return Promise.resolve();
  }
}

class MemoryUsers implements UserRepository {
  constructor(private readonly store: MemoryStore) {}
  findById(id: UserId): Promise<User | null> {
    return Promise.resolve(this.store.users.find((item) => item.id.equals(id)) ?? null);
  }
  findByNormalizedEmail(email: Email): Promise<User | null> {
    return Promise.resolve(this.store.users.find((item) => item.email.equals(email)) ?? null);
  }
  existsByNormalizedEmail(email: Email): Promise<boolean> {
    return Promise.resolve(this.store.users.some((item) => item.email.equals(email)));
  }
  save(user: User): Promise<void> {
    this.store.users.push(user);
    return Promise.resolve();
  }
  async updateLastLogin(id: UserId, lastLoginAt: Date): Promise<void> {
    const user = await this.findById(id);
    user?.recordLogin(lastLoginAt);
  }
}

class MemorySessions implements AuthenticationSessionRepository {
  constructor(private readonly store: MemoryStore) {}
  findById(id: AuthenticationSessionId): Promise<AuthenticationSession | null> {
    return Promise.resolve(this.store.sessions.find((item) => item.id.equals(id)) ?? null);
  }
  save(session: AuthenticationSession): Promise<void> {
    if (this.store.failSessionSave) {
      return Promise.reject(new Error("session persistence failed"));
    }
    this.store.sessions.push(session);
    return Promise.resolve();
  }
  async revoke(
    id: AuthenticationSessionId,
    revokedAt: Date,
    replacement: AuthenticationSessionId | null
  ): Promise<void> {
    const session = await this.findById(id);
    if (session && !session.isRevoked()) {
      if (replacement) {
        session.replaceWith(replacement, revokedAt);
      } else {
        session.revoke(revokedAt);
      }
    }
  }
  async revokeFamily(familyId: TokenFamilyId, revokedAt: Date): Promise<number> {
    let count = 0;
    for (const session of this.store.sessions) {
      if (session.tokenFamilyId.equals(familyId) && !session.isRevoked()) {
        session.revoke(revokedAt);
        count += 1;
      }
    }
    return count;
  }
  async rotate(
    currentId: AuthenticationSessionId,
    expectedHash: string,
    replacement: AuthenticationSession,
    revokedAt: Date
  ): Promise<boolean> {
    const current = await this.findById(currentId);
    if (!current || current.isRevoked() || current.tokenHashForPersistence() !== expectedHash) {
      return false;
    }
    this.store.sessions.push(replacement);
    current.replaceWith(replacement.id, revokedAt);
    return true;
  }
}

class MemoryUnitOfWork implements IdentityUnitOfWork {
  constructor(private readonly store: MemoryStore) {}
  async execute<T>(callback: (repositories: IdentityRepositories) => Promise<T>): Promise<T> {
    this.store.transactions += 1;
    const snapshot = {
      organizations: [...this.store.organizations],
      users: [...this.store.users],
      sessions: [...this.store.sessions]
    };
    try {
      return await callback(repositories(this.store));
    } catch (error: unknown) {
      this.store.organizations = snapshot.organizations;
      this.store.users = snapshot.users;
      this.store.sessions = snapshot.sessions;
      throw error;
    }
  }
}

function repositories(store: MemoryStore): IdentityRepositories {
  return {
    organizations: new MemoryOrganizations(store),
    organizationSettings: new MemoryOrganizationSettings(store),
    users: new MemoryUsers(store),
    sessions: new MemorySessions(store)
  };
}

function harness() {
  const store = new MemoryStore();
  const repos = repositories(store);
  const unitOfWork = new MemoryUnitOfWork(store);
  const passwords = new FakePasswordHasher();
  const accessTokens = new FakeAccessTokens();
  const refreshTokens = new FakeRefreshTokens();
  const clock = new FixedClock();
  const identifiers = new SequentialIdentifiers();
  const platformOwner = {
    isPlatformOwnerEmail: () => false,
    isPlatformOwnerPrincipal: () => false
  } as unknown as PlatformOwnerService;
  return {
    store,
    repos,
    passwords,
    register: new RegisterOrganizationHandler(
      unitOfWork,
      passwords,
      accessTokens,
      refreshTokens,
      clock,
      identifiers,
      lifetimes,
      platformOwner
    ),
    login: new LoginHandler(
      repos.users,
      repos.organizations,
      unitOfWork,
      passwords,
      accessTokens,
      refreshTokens,
      clock,
      identifiers,
      lifetimes,
      platformOwner
    ),
    refresh: new RefreshSessionHandler(
      repos.sessions,
      repos.users,
      repos.organizations,
      unitOfWork,
      accessTokens,
      refreshTokens,
      clock,
      identifiers,
      lifetimes,
      platformOwner
    ),
    logout: new LogoutHandler(repos.sessions, unitOfWork, refreshTokens, clock),
    current: new GetCurrentUserHandler(repos.users, repos.organizations, platformOwner),
    getOrganization: new GetOrganizationHandler(repos.users, repos.organizations, platformOwner),
    updateOrganization: new UpdateOrganizationHandler(
      repos.users,
      repos.organizations,
      unitOfWork,
      platformOwner
    ),
    getOrganizationSettings: new GetOrganizationSettingsHandler(
      repos.users,
      repos.organizations,
      repos.organizationSettings,
      unitOfWork,
      identifiers,
      platformOwner
    ),
    updateOrganizationSettings: new UpdateOrganizationSettingsHandler(
      repos.users,
      repos.organizations,
      repos.organizationSettings,
      unitOfWork,
      identifiers,
      platformOwner
    )
  };
}

const registration = {
  organizationName: "Getursoft",
  firstName: "Krishna",
  lastName: "Pandey",
  email: "ADMIN@Getursoft.com",
  password: "StrongPassword@123"
};

describe("identity application handlers", () => {
  it("registers normalized public identity and credentials atomically", async () => {
    const context = harness();
    const result = await context.register.execute(registration);

    expect(result.organization).toMatchObject({ slug: "getursoft", status: "ACTIVE" });
    expect(result.user).toMatchObject({
      email: "admin@getursoft.com",
      role: "OWNER",
      status: "ACTIVE"
    });
    expect(result.tokens.refreshToken).toContain(".");
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|tokenHash|hashed:/);
    expect(context.passwords.hashCalls).toBe(1);
    expect(context.store).toMatchObject({
      organizations: { length: 1 },
      users: { length: 1 },
      sessions: { length: 1 },
      transactions: 1
    });
  });

  it("rejects duplicate email and weak passwords and resolves slug collisions", async () => {
    const context = harness();
    await context.register.execute(registration);
    await expect(
      context.register.execute({ ...registration, organizationName: "Other" })
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_EXISTS" });
    await expect(
      context.register.execute({
        ...registration,
        email: "weak@example.com",
        password: "weakpassword"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const second = await context.register.execute({ ...registration, email: "second@example.com" });
    expect(second.organization.slug).toBe("getursoft-2");
  });

  it("rolls registration persistence back when session storage fails", async () => {
    const context = harness();
    context.store.failSessionSave = true;
    await expect(context.register.execute(registration)).rejects.toThrow(
      "session persistence failed"
    );
    expect(context.store.organizations).toHaveLength(0);
    expect(context.store.users).toHaveLength(0);
  });

  it("logs in with normalized email and updates session and last-login atomically", async () => {
    const context = harness();
    await context.register.execute(registration);
    const result = await context.login.execute({
      email: " admin@getursoft.com ",
      password: registration.password,
      organizationName: registration.organizationName
    });
    expect(result.user.email).toBe("admin@getursoft.com");
    expect(context.store.sessions).toHaveLength(2);
    expect(context.store.users[0]?.lastLoginAt).toEqual(now);
  });

  it("returns the same authentication error for unknown and incorrect credentials", async () => {
    const context = harness();
    await context.register.execute(registration);
    const attempts = [
      context.login.execute({
        email: "missing@example.com",
        password: registration.password,
        organizationName: registration.organizationName
      }),
      context.login.execute({
        email: registration.email,
        password: "IncorrectPassword@123",
        organizationName: registration.organizationName
      })
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
        message: "Invalid email or password."
      });
    }
  });

  it("rotates once, links the replacement, and revokes the family on replay", async () => {
    const context = harness();
    const registered = await context.register.execute(registration);
    const original = context.store.sessions[0];
    if (!original) throw new Error("missing fixture session");
    const rotated = await context.refresh.execute({ refreshToken: registered.tokens.refreshToken });
    expect(original.replacedBySessionId?.toString()).toBe(
      rotated.tokens.refreshToken.split(".")[0]
    );
    await expect(
      context.refresh.execute({ refreshToken: registered.tokens.refreshToken })
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
    expect(context.store.sessions.every((session) => session.isRevoked())).toBe(true);
  });

  it("rejects missing, malformed, invalid, and expired refresh credentials distinctly", async () => {
    const context = harness();
    const registered = await context.register.execute(registration);
    await expect(context.refresh.execute({ refreshToken: "malformed" })).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN"
    });
    await expect(
      context.refresh.execute({
        refreshToken: `${AuthenticationSessionId.from("00000000-0000-4000-8000-000000000099").toString()}.${"A".repeat(43)}`
      })
    ).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
    await expect(
      context.refresh.execute({ refreshToken: registered.tokens.refreshToken.replace(/A$/, "B") })
    ).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
    const current = context.store.sessions[0];
    if (!current) throw new Error("missing fixture session");
    context.store.sessions[0] = AuthenticationSession.reconstruct({
      id: current.id,
      userId: current.userId,
      activeOrganizationId: null,
      tokenHash: current.tokenHashForPersistence(),
      tokenFamilyId: current.tokenFamilyId,
      createdAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() - 1_000),
      revokedAt: null,
      replacedBySessionId: null,
      lastUsedAt: null,
      ipAddress: null,
      userAgent: null
    });
    await expect(
      context.refresh.execute({ refreshToken: registered.tokens.refreshToken })
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_EXPIRED" });
  });

  it("logs out idempotently without revealing malformed or unrelated tokens", async () => {
    const context = harness();
    const registered = await context.register.execute(registration);
    await expect(context.logout.execute({ refreshToken: "malformed" })).resolves.toEqual({
      success: true
    });
    await expect(
      context.logout.execute({ refreshToken: registered.tokens.refreshToken.replace(/A$/, "B") })
    ).resolves.toEqual({ success: true });
    expect(context.store.sessions[0]?.isRevoked()).toBe(false);
    await context.logout.execute({ refreshToken: registered.tokens.refreshToken });
    await expect(
      context.logout.execute({ refreshToken: registered.tokens.refreshToken })
    ).resolves.toEqual({ success: true });
    expect(context.store.sessions[0]?.isRevoked()).toBe(true);
  });

  it("returns current public identity and rejects missing or mismatched principals", async () => {
    const context = harness();
    await context.register.execute(registration);
    const user = context.store.users[0];
    const session = context.store.sessions[0];
    if (!user || !session) throw new Error("missing fixtures");
    const principal = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      sessionId: session.id
    };
    await expect(context.current.execute(principal)).resolves.toMatchObject({
      user: { email: "admin@getursoft.com" }
    });
    await expect(
      context.current.execute({
        ...principal,
        organizationId: OrganizationId.from("00000000-0000-4000-8000-000000000099")
      })
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    context.store.users = [];
    await expect(context.current.execute(principal)).rejects.toMatchObject({
      code: "USER_NOT_FOUND"
    });
  });

  it("rejects inactive users and organizations at login with the generic failure", async () => {
    const context = harness();
    await context.register.execute(registration);
    const user = context.store.users[0];
    const organization = context.store.organizations[0];
    if (!user || !organization) throw new Error("missing fixtures");
    context.store.users[0] = User.reconstruct({
      id: user.id,
      organizationId: user.organizationId,
      firstName: user.firstName,
      email: user.email,
      passwordHash: PasswordHash.create(user.passwordHashForPersistence()),
      role: user.role,
      status: UserStatus.SUSPENDED,
      lastLoginAt: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
    await expect(
      context.login.execute({
        email: registration.email,
        password: registration.password,
        organizationName: registration.organizationName
      })
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    context.store.users[0] = user;
    context.store.organizations[0] = Organization.reconstruct({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: OrganizationStatus.SUSPENDED,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt
    });
    await expect(
      context.login.execute({
        email: registration.email,
        password: registration.password,
        organizationName: registration.organizationName
      })
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("returns and updates the authenticated organization without changing slug or status", async () => {
    const context = harness();
    const registered = await context.register.execute(registration);
    const user = context.store.users[0];
    const session = context.store.sessions[0];
    if (!user || !session) throw new Error("missing fixtures");
    const principal = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      sessionId: session.id
    };

    await expect(context.getOrganization.execute(principal)).resolves.toMatchObject({
      organization: {
        name: "Getursoft",
        slug: registered.organization.slug,
        status: "ACTIVE"
      }
    });

    const updated = await context.updateOrganization.execute(principal, { name: "Updated Org" });
    expect(updated.organization).toMatchObject({
      name: "Updated Org",
      slug: registered.organization.slug,
      status: "ACTIVE"
    });
    expect(context.store.organizations[0]?.slug.toString()).toBe(registered.organization.slug);
  });

  it("creates default organization settings and updates them atomically", async () => {
    const context = harness();
    await context.register.execute(registration);
    const user = context.store.users[0];
    const session = context.store.sessions[0];
    if (!user || !session) throw new Error("missing fixtures");
    const principal = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      sessionId: session.id
    };

    const defaults = await context.getOrganizationSettings.execute(principal);
    expect(defaults.organizationSetting).toMatchObject({
      timezone: "UTC",
      currency: "USD",
      locale: "en-US"
    });
    expect(context.store.organizationSettings).toHaveLength(1);

    const updated = await context.updateOrganizationSettings.execute(principal, {
      timezone: "America/New_York",
      currency: "EUR",
      locale: "de-DE"
    });
    expect(updated.organizationSetting).toMatchObject({
      timezone: "America/New_York",
      currency: "EUR",
      locale: "de-DE"
    });
  });

  it("rejects invalid organization and settings updates", async () => {
    const context = harness();
    await context.register.execute(registration);
    const user = context.store.users[0];
    const session = context.store.sessions[0];
    if (!user || !session) throw new Error("missing fixtures");
    const principal = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      sessionId: session.id
    };

    await expect(
      context.updateOrganization.execute(principal, { name: "ab" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      context.updateOrganizationSettings.execute(principal, {
        timezone: "Invalid/Zone"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      context.updateOrganizationSettings.execute(principal, {
        currency: "EURO"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      context.updateOrganizationSettings.execute(principal, {
        locale: "not-a-locale"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
