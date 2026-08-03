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
import type { RefreshTokenService } from "../ports/refresh-token-service";
import type { UserRepository } from "../ports/user-repository";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { OrganizationId } from "../../domain/organization/organization-id";
import { OrganizationStatus } from "../../domain/organization/organization-status";
import { TokenFamilyId } from "../../domain/authentication/token-family-id";

export interface SwitchOrganizationCommand {
  organizationId: string;
}

export const SWITCH_ORGANIZATION = Symbol("SwitchOrganization");

/**
 * Lets the universal platform owner move their session into another organization. Because the owner
 * has no membership row there, a brand-new session records the target organization as its
 * `activeOrganizationId` so token refreshes keep operating there (see RefreshSessionHandler).
 */
export class SwitchOrganizationHandler {
  constructor(
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

  async execute(
    principal: AuthenticatedPrincipal,
    command: SwitchOrganizationCommand
  ): Promise<AuthenticationResult> {
    if (!this.platformOwner.isPlatformOwnerPrincipal(principal)) {
      throw identityError.platformOwnerRequired();
    }
    const target = await this.organizations.findById(OrganizationId.from(command.organizationId));
    if (!target || target.status !== OrganizationStatus.ACTIVE) {
      throw identityError.organizationNotFound();
    }
    const user = await this.users.findById(principal.userId);
    if (!user || !user.canAuthenticate()) {
      throw identityError.authorizationFailed();
    }
    const now = this.clock.now();
    const sessionId = AuthenticationSessionId.from(this.identifiers.generate());
    const rawRefreshToken = this.refreshTokens.generate(sessionId);
    const session = AuthenticationSession.create({
      id: sessionId,
      userId: user.id,
      activeOrganizationId: target.id,
      tokenHash: this.refreshTokens.hash(rawRefreshToken),
      tokenFamilyId: TokenFamilyId.from(this.identifiers.generate()),
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenExpiresInSeconds * 1000),
      now
    });
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.sessions.save(session);
    });
    const isPlatformOwner = this.platformOwner.isPlatformOwnerEmail(user.email.toString());
    const accessToken = await this.accessTokens.issue(
      principalFor(user, sessionId, { isPlatformOwner, organizationId: target.id }),
      now
    );
    return {
      organization: publicOrganization(target),
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
