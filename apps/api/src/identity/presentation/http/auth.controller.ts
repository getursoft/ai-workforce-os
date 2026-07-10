import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import {
  GET_CURRENT_USER,
  type GetCurrentUserHandler
} from "../../application/handlers/get-current-user";
import { LOGIN, type LoginHandler } from "../../application/handlers/login";
import { LOGOUT, type LogoutHandler } from "../../application/handlers/logout";
import {
  REFRESH_SESSION,
  type RefreshSessionHandler
} from "../../application/handlers/refresh-session";
import {
  REGISTER_ORGANIZATION,
  type RegisterOrganizationHandler
} from "../../application/handlers/register-organization";
import { IdentityApplicationError } from "../../application/errors/identity.error";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { LoginDto, RefreshTokenDto, RegisterOrganizationDto } from "./auth.dto";
import { CurrentPrincipal } from "./current-principal.decorator";
import type { IdentityRequest } from "./request-context";
import { JwtAccessGuard } from "./jwt-access.guard";
import { SecurityEventLogger } from "./security-event-logger";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(REGISTER_ORGANIZATION)
    private readonly registerOrganization: RegisterOrganizationHandler,
    @Inject(LOGIN) private readonly loginHandler: LoginHandler,
    @Inject(REFRESH_SESSION) private readonly refreshSession: RefreshSessionHandler,
    @Inject(LOGOUT) private readonly logoutHandler: LogoutHandler,
    @Inject(GET_CURRENT_USER) private readonly getCurrentUser: GetCurrentUserHandler,
    private readonly securityLogger: SecurityEventLogger
  ) {}

  @Post("register")
  async register(@Body() dto: RegisterOrganizationDto, @Req() request: IdentityRequest) {
    try {
      const result = await this.registerOrganization.execute(dto);
      this.securityLogger.success("registration_success", request.requestId, {
        userId: result.user.id,
        organizationId: result.organization.id
      });
      return { data: result };
    } catch (error: unknown) {
      this.logFailure("registration_failure", request.requestId, error);
      throw error;
    }
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: IdentityRequest) {
    try {
      const result = await this.loginHandler.execute(dto);
      this.securityLogger.success("login_success", request.requestId, {
        userId: result.user.id,
        organizationId: result.organization.id
      });
      return { data: result };
    } catch (error: unknown) {
      this.logFailure("login_failure", request.requestId, error);
      throw error;
    }
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: IdentityRequest) {
    try {
      const result = await this.refreshSession.execute(dto);
      this.securityLogger.success("refresh_success", request.requestId, {
        userId: result.user.id,
        organizationId: result.organization.id
      });
      return { data: result };
    } catch (error: unknown) {
      const event =
        error instanceof IdentityApplicationError && error.code === "REFRESH_TOKEN_REUSED"
          ? "refresh_token_reuse_detected"
          : "refresh_failure";
      this.logFailure(event, request.requestId, error);
      throw error;
    }
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Body() dto: RefreshTokenDto, @Req() request: IdentityRequest) {
    const result = await this.logoutHandler.execute(dto);
    this.securityLogger.success("logout", request.requestId);
    return { data: result };
  }

  @Get("me")
  @UseGuards(JwtAccessGuard)
  async me(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Req() request: IdentityRequest) {
    try {
      return { data: await this.getCurrentUser.execute(principal) };
    } catch (error: unknown) {
      this.logFailure("me_unauthorized", request.requestId, error);
      throw error;
    }
  }

  private logFailure(event: string, requestId: string, error: unknown): void {
    const category = error instanceof IdentityApplicationError ? error.code : "internal";
    this.securityLogger.failure(event, requestId, category);
  }
}
