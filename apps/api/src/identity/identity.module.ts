import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { ACCESS_TOKEN_SERVICE } from "./application/ports/access-token-service";
import {
  AUTHENTICATION_LIFETIMES,
  type AuthenticationLifetimes
} from "./application/ports/authentication-lifetimes";
import { AUTHENTICATION_SESSION_REPOSITORY } from "./application/ports/authentication-session-repository";
import { CLOCK, type Clock } from "./application/ports/clock";
import { IDENTITY_UNIT_OF_WORK } from "./application/ports/identity-unit-of-work";
import { IDENTIFIER_GENERATOR } from "./application/ports/identifier-generator";
import { ORGANIZATION_REPOSITORY } from "./application/ports/organization-repository";
import { PASSWORD_HASHER } from "./application/ports/password-hasher";
import { REFRESH_TOKEN_SERVICE } from "./application/ports/refresh-token-service";
import { USER_REPOSITORY } from "./application/ports/user-repository";
import { PrismaAuthenticationSessionRepository } from "./infrastructure/persistence/prisma/repositories/prisma-authentication-session.repository";
import { PrismaIdentityUnitOfWork } from "./infrastructure/persistence/prisma/prisma-identity-unit-of-work";
import { PrismaOrganizationRepository } from "./infrastructure/persistence/prisma/repositories/prisma-organization.repository";
import { PrismaUserRepository } from "./infrastructure/persistence/prisma/repositories/prisma-user.repository";
import { Argon2PasswordHasher } from "./infrastructure/security/argon2-password-hasher";
import { CryptoIdentifierGenerator } from "./infrastructure/security/crypto-identifier-generator";
import { HmacRefreshTokenService } from "./infrastructure/security/hmac-refresh-token-service";
import { JoseAccessTokenService } from "./infrastructure/security/jose-access-token-service";
import {
  loadSecurityConfig,
  SECURITY_CONFIG,
  type SecurityConfig
} from "./infrastructure/security/security-config";
import { SystemClock } from "./infrastructure/security/system-clock";
import {
  REGISTER_ORGANIZATION,
  RegisterOrganizationHandler
} from "./application/handlers/register-organization";
import { LOGIN, LoginHandler } from "./application/handlers/login";
import { REFRESH_SESSION, RefreshSessionHandler } from "./application/handlers/refresh-session";
import { LOGOUT, LogoutHandler } from "./application/handlers/logout";
import { GET_CURRENT_USER, GetCurrentUserHandler } from "./application/handlers/get-current-user";
import type { AccessTokenService } from "./application/ports/access-token-service";
import type { AuthenticationSessionRepository } from "./application/ports/authentication-session-repository";
import type { IdentifierGenerator } from "./application/ports/identifier-generator";
import type { IdentityUnitOfWork } from "./application/ports/identity-unit-of-work";
import type { OrganizationRepository } from "./application/ports/organization-repository";
import type { PasswordHasher } from "./application/ports/password-hasher";
import type { RefreshTokenService } from "./application/ports/refresh-token-service";
import type { UserRepository } from "./application/ports/user-repository";
import { AuthController } from "./presentation/http/auth.controller";
import { JwtAccessGuard } from "./presentation/http/jwt-access.guard";
import { RequestIdMiddleware } from "./presentation/http/request-id.middleware";
import { SecurityEventLogger } from "./presentation/http/security-event-logger";

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    {
      provide: SECURITY_CONFIG,
      useFactory: (): SecurityConfig => loadSecurityConfig(process.env)
    },
    {
      provide: CLOCK,
      useClass: SystemClock
    },
    {
      provide: IDENTIFIER_GENERATOR,
      useClass: CryptoIdentifierGenerator
    },
    {
      provide: PASSWORD_HASHER,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) => new Argon2PasswordHasher(config.passwordHash)
    },
    {
      provide: ACCESS_TOKEN_SERVICE,
      inject: [SECURITY_CONFIG, CLOCK],
      useFactory: (config: SecurityConfig, clock: Clock) =>
        new JoseAccessTokenService(config.accessToken, clock)
    },
    {
      provide: REFRESH_TOKEN_SERVICE,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig) =>
        new HmacRefreshTokenService(config.refreshToken.pepper)
    },
    {
      provide: AUTHENTICATION_LIFETIMES,
      inject: [SECURITY_CONFIG],
      useFactory: (config: SecurityConfig): AuthenticationLifetimes => ({
        accessTokenExpiresInSeconds: config.accessToken.expiresInSeconds,
        refreshTokenExpiresInSeconds: config.refreshToken.expiresInSeconds
      })
    },
    {
      provide: ORGANIZATION_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaOrganizationRepository(prisma)
    },
    {
      provide: USER_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaUserRepository(prisma)
    },
    {
      provide: AUTHENTICATION_SESSION_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaAuthenticationSessionRepository(prisma)
    },
    {
      provide: IDENTITY_UNIT_OF_WORK,
      useClass: PrismaIdentityUnitOfWork
    },
    {
      provide: REGISTER_ORGANIZATION,
      inject: [
        IDENTITY_UNIT_OF_WORK,
        PASSWORD_HASHER,
        ACCESS_TOKEN_SERVICE,
        REFRESH_TOKEN_SERVICE,
        CLOCK,
        IDENTIFIER_GENERATOR,
        AUTHENTICATION_LIFETIMES
      ],
      useFactory: (
        unitOfWork: IdentityUnitOfWork,
        passwordHasher: PasswordHasher,
        accessTokens: AccessTokenService,
        refreshTokens: RefreshTokenService,
        clock: Clock,
        identifiers: IdentifierGenerator,
        lifetimes: AuthenticationLifetimes
      ) =>
        new RegisterOrganizationHandler(
          unitOfWork,
          passwordHasher,
          accessTokens,
          refreshTokens,
          clock,
          identifiers,
          lifetimes
        )
    },
    {
      provide: LOGIN,
      inject: [
        USER_REPOSITORY,
        ORGANIZATION_REPOSITORY,
        IDENTITY_UNIT_OF_WORK,
        PASSWORD_HASHER,
        ACCESS_TOKEN_SERVICE,
        REFRESH_TOKEN_SERVICE,
        CLOCK,
        IDENTIFIER_GENERATOR,
        AUTHENTICATION_LIFETIMES
      ],
      useFactory: (
        users: UserRepository,
        organizations: OrganizationRepository,
        unitOfWork: IdentityUnitOfWork,
        passwordHasher: PasswordHasher,
        accessTokens: AccessTokenService,
        refreshTokens: RefreshTokenService,
        clock: Clock,
        identifiers: IdentifierGenerator,
        lifetimes: AuthenticationLifetimes
      ) =>
        new LoginHandler(
          users,
          organizations,
          unitOfWork,
          passwordHasher,
          accessTokens,
          refreshTokens,
          clock,
          identifiers,
          lifetimes
        )
    },
    {
      provide: REFRESH_SESSION,
      inject: [
        AUTHENTICATION_SESSION_REPOSITORY,
        USER_REPOSITORY,
        ORGANIZATION_REPOSITORY,
        IDENTITY_UNIT_OF_WORK,
        ACCESS_TOKEN_SERVICE,
        REFRESH_TOKEN_SERVICE,
        CLOCK,
        IDENTIFIER_GENERATOR,
        AUTHENTICATION_LIFETIMES
      ],
      useFactory: (
        sessions: AuthenticationSessionRepository,
        users: UserRepository,
        organizations: OrganizationRepository,
        unitOfWork: IdentityUnitOfWork,
        accessTokens: AccessTokenService,
        refreshTokens: RefreshTokenService,
        clock: Clock,
        identifiers: IdentifierGenerator,
        lifetimes: AuthenticationLifetimes
      ) =>
        new RefreshSessionHandler(
          sessions,
          users,
          organizations,
          unitOfWork,
          accessTokens,
          refreshTokens,
          clock,
          identifiers,
          lifetimes
        )
    },
    {
      provide: LOGOUT,
      inject: [
        AUTHENTICATION_SESSION_REPOSITORY,
        IDENTITY_UNIT_OF_WORK,
        REFRESH_TOKEN_SERVICE,
        CLOCK
      ],
      useFactory: (
        sessions: AuthenticationSessionRepository,
        unitOfWork: IdentityUnitOfWork,
        refreshTokens: RefreshTokenService,
        clock: Clock
      ) => new LogoutHandler(sessions, unitOfWork, refreshTokens, clock)
    },
    {
      provide: GET_CURRENT_USER,
      inject: [USER_REPOSITORY, ORGANIZATION_REPOSITORY],
      useFactory: (users: UserRepository, organizations: OrganizationRepository) =>
        new GetCurrentUserHandler(users, organizations)
    },
    JwtAccessGuard,
    RequestIdMiddleware,
    SecurityEventLogger
  ],
  exports: [
    ORGANIZATION_REPOSITORY,
    USER_REPOSITORY,
    AUTHENTICATION_SESSION_REPOSITORY,
    IDENTITY_UNIT_OF_WORK,
    PASSWORD_HASHER,
    ACCESS_TOKEN_SERVICE,
    REFRESH_TOKEN_SERVICE,
    CLOCK,
    IDENTIFIER_GENERATOR
  ]
})
export class IdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
