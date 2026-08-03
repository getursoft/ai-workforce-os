import { identityError } from "../errors/identity.error";
import {
  principalFor,
  publicOrganization,
  publicUser,
  type AuthenticationResult
} from "../models/identity-result";
import type { AccessTokenService } from "../ports/access-token-service";
import type { AuthenticationLifetimes } from "../ports/authentication-lifetimes";
import type { AuthenticationSessionRepository } from "../ports/authentication-session-repository";
import type { Clock } from "../ports/clock";
import type { IdentifierGenerator } from "../ports/identifier-generator";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { RefreshTokenService } from "../ports/refresh-token-service";
import type { UserRepository } from "../ports/user-repository";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { InvalidRefreshTokenFormatError } from "../errors/security.error";
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { OrganizationId } from "../../domain/organization/organization-id";
import { OrganizationStatus } from "../../domain/organization/organization-status";

export interface RefreshSessionCommand {
  refreshToken: string;
}

export const REFRESH_SESSION = Symbol("RefreshSession");

export class RefreshSessionHandler {
  constructor(
    private readonly sessions: AuthenticationSessionRepository,
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository,
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly clock: Clock,
    private readonly identifiers: IdentifierGenerator,
    private readonly lifetimes: AuthenticationLifetimes,
    private readonly platformOwner: PlatformOwnerService
  ) {}

  async execute(command: RefreshSessionCommand): Promise<AuthenticationResult> {
    let sessionId: AuthenticationSessionId;
    try {
      sessionId = this.refreshTokens.parse(command.refreshToken).sessionId;
    } catch (error: unknown) {
      if (error instanceof InvalidRefreshTokenFormatError) {
        throw identityError.invalidRefreshToken();
      }
      throw error;
    }
    const current = await this.sessions.findById(sessionId);
    if (
      !current ||
      !this.refreshTokens.verifyHash(command.refreshToken, current.tokenHashForPersistence())
    ) {
      throw identityError.invalidRefreshToken();
    }
    const now = this.clock.now();
    if (current.isRevoked()) {
      await this.unitOfWork.execute(async (repositories) => {
        await repositories.sessions.revokeFamily(current.tokenFamilyId, now);
      });
      throw identityError.refreshTokenReused();
    }
    if (current.isExpired(now)) {
      throw identityError.refreshTokenExpired();
    }
    const user = await this.users.findById(current.userId);
    if (!user || !user.canAuthenticate()) {
      throw identityError.invalidRefreshToken();
    }
    // A platform-owner org-switch session keeps operating in the switched organization across
    // refreshes (session.activeOrganizationId); every other session uses the user's home org.
    const activeOrganizationId = current.activeOrganizationId ?? user.organizationId;
    const organization = await this.organizations.findById(activeOrganizationId);
    if (!organization || organization.status !== OrganizationStatus.ACTIVE) {
      throw identityError.invalidRefreshToken();
    }
    const replacementId = AuthenticationSessionId.from(this.identifiers.generate());
    const rawRefreshToken = this.refreshTokens.generate(replacementId);
    const replacement = AuthenticationSession.create({
      id: replacementId,
      userId: user.id,
      ...(current.activeOrganizationId
        ? { activeOrganizationId: OrganizationId.from(current.activeOrganizationId.toString()) }
        : {}),
      tokenHash: this.refreshTokens.hash(rawRefreshToken),
      tokenFamilyId: current.tokenFamilyId,
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenExpiresInSeconds * 1000),
      now
    });
    const rotated = await this.unitOfWork.execute(async (repositories) => {
      const success = await repositories.sessions.rotate(
        current.id,
        current.tokenHashForPersistence(),
        replacement,
        now
      );
      if (!success) {
        await repositories.sessions.revokeFamily(current.tokenFamilyId, now);
      }
      return success;
    });
    if (!rotated) {
      throw identityError.refreshTokenReused();
    }
    const isPlatformOwner = this.platformOwner.isPlatformOwnerEmail(user.email.toString());
    const accessToken = await this.accessTokens.issue(
      principalFor(user, replacementId, {
        isPlatformOwner,
        organizationId: activeOrganizationId
      }),
      now
    );
    return {
      organization: publicOrganization(organization),
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
