import { identityError } from "../errors/identity.error";
import {
  principalFor,
  publicOrganization,
  publicUser,
  type AuthenticationResult
} from "../models/identity-result";
import type { AccessTokenService } from "../ports/access-token-service";
import type { AuthenticationLifetimes } from "../ports/authentication-lifetimes";
import type { Clock } from "../ports/clock";
import type { IdentifierGenerator } from "../ports/identifier-generator";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { PasswordHasher } from "../ports/password-hasher";
import type { RefreshTokenService } from "../ports/refresh-token-service";
import type { UserRepository } from "../ports/user-repository";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../domain/authentication/token-family-id";
import { OrganizationStatus } from "../../domain/organization/organization-status";
import { Email } from "../../domain/user/email";

export interface LoginCommand {
  email: string;
  password: string;
  organizationName: string;
}

export const LOGIN = Symbol("Login");

export class LoginHandler {
  constructor(
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository,
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly clock: Clock,
    private readonly identifiers: IdentifierGenerator,
    private readonly lifetimes: AuthenticationLifetimes,
    private readonly platformOwner: PlatformOwnerService
  ) {}

  async execute(command: LoginCommand): Promise<AuthenticationResult> {
    const email = Email.create(command.email);
    const now = this.clock.now();
    const user = await this.users.findByNormalizedEmail(email);
    if (!user) {
      await this.passwordHasher.hash(command.password);
      throw identityError.authenticationFailed();
    }
    if (user.isLockedOut(now)) {
      throw identityError.accountLocked();
    }
    const passwordValid = await this.passwordHasher.verify(
      command.password,
      user.passwordHashForPersistence()
    );
    if (!passwordValid) {
      await this.users.recordFailedLogin(
        user.id,
        this.lifetimes.accountLockout.maxFailedAttempts,
        this.lifetimes.accountLockout.lockoutDurationSeconds,
        now
      );
      throw identityError.authenticationFailed();
    }
    const organization = await this.organizations.findById(user.organizationId);
    if (!user.canAuthenticate() || !organization || organization.status !== OrganizationStatus.ACTIVE) {
      throw identityError.authenticationFailed();
    }
    const isPlatformOwner = this.platformOwner.isPlatformOwnerEmail(user.email.toString());
    // Company-selected login: every login must name the organization it targets. The platform owner
    // can open any active organization; every other user may only enter their own organization's name.
    // The chosen organization becomes the session's active organization so token refreshes keep
    // operating there.
    const target = await this.organizations.findByName(command.organizationName);
    if (!target || target.status !== OrganizationStatus.ACTIVE) {
      throw identityError.organizationNotFound();
    }
    if (!isPlatformOwner && !target.id.equals(user.organizationId)) {
      throw identityError.organizationSwitchDenied();
    }
    const activeOrganizationId = target.id;
    const sessionId = AuthenticationSessionId.from(this.identifiers.generate());
    const rawRefreshToken = this.refreshTokens.generate(sessionId);
    const session = AuthenticationSession.create({
      id: sessionId,
      userId: user.id,
      ...(activeOrganizationId.equals(user.organizationId)
        ? {}
        : { activeOrganizationId }),
      tokenHash: this.refreshTokens.hash(rawRefreshToken),
      tokenFamilyId: TokenFamilyId.from(this.identifiers.generate()),
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenExpiresInSeconds * 1000),
      now
    });
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.sessions.save(session);
      await repositories.users.updateLastLogin(user.id, now);
    });
    const accessToken = await this.accessTokens.issue(
      principalFor(user, sessionId, { isPlatformOwner, organizationId: activeOrganizationId }),
      now
    );
    const sessionOrganization = await this.organizations.findById(activeOrganizationId);
    return {
      organization: publicOrganization(sessionOrganization ?? organization),
      user: publicUser(user, isPlatformOwner),
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        accessTokenExpiresIn: this.lifetimes.accessTokenExpiresInSeconds,
        refreshTokenExpiresIn: this.lifetimes.refreshTokenExpiresInSeconds
      }
    };
  }
}
