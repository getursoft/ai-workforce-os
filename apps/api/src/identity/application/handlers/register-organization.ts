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
import type { PasswordHasher } from "../ports/password-hasher";
import { PersistenceConflictError } from "../ports/persistence-error";
import type { RefreshTokenService } from "../ports/refresh-token-service";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { uniqueOrganizationSlug } from "../services/organization-slug";
import { validatePassword } from "../services/password-policy";
import { AuthenticationSession } from "../../domain/authentication/authentication-session";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { TokenFamilyId } from "../../domain/authentication/token-family-id";
import { Organization } from "../../domain/organization/organization";
import { OrganizationId } from "../../domain/organization/organization-id";
import { OrganizationName } from "../../domain/organization/organization-name";
import { Email } from "../../domain/user/email";
import { PasswordHash } from "../../domain/user/password-hash";
import { User } from "../../domain/user/user";
import { UserId } from "../../domain/user/user-id";

export interface RegisterOrganizationCommand {
  organizationName: string;
  firstName: string;
  lastName?: string;
  email: string;
  password: string;
}

export const REGISTER_ORGANIZATION = Symbol("RegisterOrganization");

export class RegisterOrganizationHandler {
  constructor(
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly clock: Clock,
    private readonly identifiers: IdentifierGenerator,
    private readonly lifetimes: AuthenticationLifetimes,
    private readonly platformOwner: PlatformOwnerService
  ) {}

  async execute(command: RegisterOrganizationCommand): Promise<AuthenticationResult> {
    validatePassword(command.password);
    const email = Email.create(command.email);
    const passwordHash = PasswordHash.create(await this.passwordHasher.hash(command.password));
    const now = this.clock.now();
    const organizationId = OrganizationId.from(this.identifiers.generate());
    const userId = UserId.from(this.identifiers.generate());
    const sessionId = AuthenticationSessionId.from(this.identifiers.generate());
    const familyId = TokenFamilyId.from(this.identifiers.generate());
    const rawRefreshToken = this.refreshTokens.generate(sessionId);
    const session = AuthenticationSession.create({
      id: sessionId,
      userId,
      tokenHash: this.refreshTokens.hash(rawRefreshToken),
      tokenFamilyId: familyId,
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenExpiresInSeconds * 1000),
      now
    });

    try {
      const persisted = await this.unitOfWork.execute(async (repositories) => {
        if (await repositories.users.existsByNormalizedEmail(email)) {
          throw identityError.emailAlreadyExists();
        }
        const slug = await uniqueOrganizationSlug(
          command.organizationName,
          repositories.organizations
        );
        const organization = Organization.create(
          organizationId,
          OrganizationName.create(command.organizationName),
          slug,
          now
        );
        const user = User.registerOwner({
          id: userId,
          organizationId,
          firstName: command.firstName,
          ...(command.lastName === undefined ? {} : { lastName: command.lastName }),
          email,
          passwordHash,
          now
        });
        await repositories.organizations.save(organization);
        await repositories.users.save(user);
        await repositories.sessions.save(session);
        return { organization, user };
      });
      const accessToken = await this.accessTokens.issue(
        principalFor(persisted.user, sessionId, {
          isPlatformOwner: this.platformOwner.isPlatformOwnerEmail(
            persisted.user.email.toString()
          )
        }),
        now
      );
      return {
        organization: publicOrganization(persisted.organization),
        user: publicUser(
          persisted.user,
          this.platformOwner.isPlatformOwnerEmail(persisted.user.email.toString())
        ),
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          accessTokenExpiresIn: this.lifetimes.accessTokenExpiresInSeconds,
          refreshTokenExpiresIn: this.lifetimes.refreshTokenExpiresInSeconds
        }
      };
    } catch (error: unknown) {
      if (error instanceof PersistenceConflictError) {
        if (error.constraint.includes("normalized_email")) {
          throw identityError.emailAlreadyExists();
        }
        throw identityError.conflict();
      }
      throw error;
    }
  }
}
