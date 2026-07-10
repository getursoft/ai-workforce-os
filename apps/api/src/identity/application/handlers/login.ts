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
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../domain/authentication/token-family-id";
import { OrganizationStatus } from "../../domain/organization/organization-status";
import { Email } from "../../domain/user/email";

export interface LoginCommand {
  email: string;
  password: string;
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
    private readonly lifetimes: AuthenticationLifetimes
  ) {}

  async execute(command: LoginCommand): Promise<AuthenticationResult> {
    const email = Email.create(command.email);
    const user = await this.users.findByNormalizedEmail(email);
    if (!user) {
      await this.passwordHasher.hash(command.password);
      throw identityError.authenticationFailed();
    }
    const passwordValid = await this.passwordHasher.verify(
      command.password,
      user.passwordHashForPersistence()
    );
    const organization = await this.organizations.findById(user.organizationId);
    if (
      !passwordValid ||
      !user.canAuthenticate() ||
      !organization ||
      organization.status !== OrganizationStatus.ACTIVE
    ) {
      throw identityError.authenticationFailed();
    }
    const now = this.clock.now();
    const sessionId = AuthenticationSessionId.from(this.identifiers.generate());
    const rawRefreshToken = this.refreshTokens.generate(sessionId);
    const session = AuthenticationSession.create({
      id: sessionId,
      userId: user.id,
      tokenHash: this.refreshTokens.hash(rawRefreshToken),
      tokenFamilyId: TokenFamilyId.from(this.identifiers.generate()),
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenExpiresInSeconds * 1000),
      now
    });
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.sessions.save(session);
      await repositories.users.updateLastLogin(user.id, now);
    });
    const accessToken = await this.accessTokens.issue(principalFor(user, sessionId), now);
    return {
      organization: publicOrganization(organization),
      user: publicUser(user),
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        accessTokenExpiresIn: this.lifetimes.accessTokenExpiresInSeconds,
        refreshTokenExpiresIn: this.lifetimes.refreshTokenExpiresInSeconds
      }
    };
  }
}
