import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { RateLimit } from "../../../security/rate-limit.decorator";
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
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../../infrastructure/security/security-config";
import {
  LoginDto,
  RefreshTokenDto,
  RegisterOrganizationDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto
} from "./auth.dto";
import { PasswordResetService } from "../../application/services/password-reset.service";
import { EmailVerificationService } from "../../application/services/email-verification.service";
import { EmailService, EmailNotConfiguredError } from "../../../notifications/email.service";
import {
  clearRefreshTokenCookie,
  readRefreshTokenFromRequest,
  setRefreshTokenCookie
} from "./browser-cookie";
import { CurrentPrincipal } from "./current-principal.decorator";
import type { IdentityRequest, IdentityResponse } from "./request-context";
import { JwtAccessGuard } from "./jwt-access.guard";
import { SecurityEventLogger } from "./security-event-logger";
import { AuditEventLogger } from "./audit-event.logger";
import { buildPasswordResetEmail } from "./password-reset-email.template";
import { RESET_TOKEN_LIFETIME_MINUTES } from "../../application/services/password-reset.service";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(REGISTER_ORGANIZATION)
    private readonly registerOrganization: RegisterOrganizationHandler,
    @Inject(LOGIN) private readonly loginHandler: LoginHandler,
    @Inject(REFRESH_SESSION) private readonly refreshSession: RefreshSessionHandler,
    @Inject(LOGOUT) private readonly logoutHandler: LogoutHandler,
    @Inject(GET_CURRENT_USER) private readonly getCurrentUser: GetCurrentUserHandler,
    @Inject(SECURITY_CONFIG) private readonly securityConfig: SecurityConfig,
    private readonly passwordReset: PasswordResetService,
    private readonly emailVerification: EmailVerificationService,
    private readonly emailService: EmailService,
    private readonly securityLogger: SecurityEventLogger,
    private readonly auditLogger: AuditEventLogger
  ) {}

  @Post("register")
  @RateLimit("AUTH_STRICT")
  async register(
    @Body() dto: RegisterOrganizationDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: IdentityResponse
  ) {
    if (!this.securityConfig.publicSignupEnabled) {
      throw new IdentityApplicationError(
        "SIGNUP_DISABLED",
        "Self-service signup is disabled. Organizations are provisioned by the platform owner."
      );
    }
    try {
      const result = await this.registerOrganization.execute(dto);
      this.setRefreshCookie(response, result.tokens.refreshToken);
      this.securityLogger.success("registration_success", request.requestId, {
        userId: result.user.id,
        organizationId: result.organization.id
      });
      const verificationToken = await this.sendVerificationEmail(result.user.id, request.requestId);
      return {
        data: {
          ...result,
          ...(verificationToken ? { emailVerificationToken: verificationToken } : {})
        }
      };
    } catch (error: unknown) {
      this.logFailure("registration_failure", request.requestId, error);
      throw error;
    }
  }

  @Post("login")
  @HttpCode(200)
  @RateLimit("AUTH_STRICT")
  async login(
    @Body() dto: LoginDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: IdentityResponse
  ) {
    try {
      const result = await this.loginHandler.execute(dto);
      this.setRefreshCookie(response, result.tokens.refreshToken);
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
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: IdentityResponse
  ) {
    try {
      const result = await this.refreshSession.execute({
        refreshToken: dto.refreshToken ?? readRefreshTokenFromRequest(request) ?? ""
      });
      this.setRefreshCookie(response, result.tokens.refreshToken);
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
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: IdentityResponse
  ) {
    const result = await this.logoutHandler.execute({
      refreshToken: dto.refreshToken ?? readRefreshTokenFromRequest(request) ?? ""
    });
    clearRefreshTokenCookie(response, this.securityConfig.browserAuth);
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

  @Post("forgot-password")
  @HttpCode(200)
  @RateLimit("AUTH_STRICT")
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: IdentityRequest) {
    // CRITICAL: the response is identical whether or not the account exists — requestReset() returns
    // an empty resetToken for an unknown email but never throws, so this whole method (including the
    // audit trail below) always follows the same code path regardless of account existence.
    this.auditLogger.record("PASSWORD_RESET_REQUESTED", request.requestId, {});
    try {
      const result = await this.passwordReset.requestReset(dto.email);
      // In production the reset token must be delivered out-of-band (email) — never in the API
      // response. In development/test (no SMTP transport expected) it is returned so the flow is
      // usable end-to-end, mirroring resend-verification.
      const returnToken = this.securityConfig.allowDevelopmentImplementations;
      const emailSent = result.resetToken
        ? await this.sendPasswordResetEmail(result.email, result.resetToken, request.requestId)
        : false;
      this.securityLogger.success("forgot_password_requested", request.requestId);
      return {
        data: {
          email: result.email,
          // Uniform response SHAPE (not just value) regardless of account existence — in dev/test mode
          // the key is always present (empty string for an unknown/inactive account); in production
          // `returnToken` is false so the key is never present either way. Either branch alone is safe;
          // what must never happen is the key's mere presence/absence differing between the two cases.
          ...(returnToken ? { resetToken: result.resetToken, emailSent } : {})
        }
      };
    } catch (error: unknown) {
      this.logFailure("forgot_password_failed", request.requestId, error);
      throw error;
    }
  }

  @Post("reset-password")
  @HttpCode(200)
  @RateLimit("AUTH_STRICT")
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() request: IdentityRequest) {
    try {
      await this.passwordReset.confirmReset({
        email: dto.email,
        token: dto.token,
        newPassword: dto.newPassword
      });
      this.securityLogger.success("password_reset", request.requestId);
      this.auditLogger.record("PASSWORD_RESET_COMPLETED", request.requestId, {});
      return { data: { success: true } };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "RESET_TOKEN_INVALID") {
        this.auditLogger.record("PASSWORD_RESET_INVALID_TOKEN", request.requestId, {});
      }
      this.logFailure("password_reset_failed", request.requestId, error);
      throw error;
    }
  }

  /**
   * Best-effort: reset-email delivery never blocks or fails the forgot-password response — a caller
   * always gets the same generic acknowledgement regardless of whether SMTP is configured, reachable,
   * or the send succeeds. The reset URL is built exclusively from the server's own configured
   * `webAppUrl`, never from the request's Host header. Returns whether the email genuinely sent, so
   * the (dev-mode-only) response can tell a real caller apart from an unconfigured/failed one instead
   * of always claiming "email delivery is not configured" regardless of what actually happened.
   */
  private async sendPasswordResetEmail(email: string, rawToken: string, requestId: string): Promise<boolean> {
    if (!this.emailService.isConfigured()) return false;
    const resetUrl = `${this.securityConfig.webAppUrl}/reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`;
    const content = buildPasswordResetEmail({ otp: rawToken, resetUrl, expiresInMinutes: RESET_TOKEN_LIFETIME_MINUTES });
    try {
      await this.emailService.sendMail({ to: email, subject: content.subject, text: content.text, html: content.html });
      this.auditLogger.record("PASSWORD_RESET_EMAIL_SENT", requestId, {});
      return true;
    } catch (error: unknown) {
      if (!(error instanceof EmailNotConfiguredError)) {
        this.auditLogger.record("PASSWORD_RESET_EMAIL_FAILED", requestId, {
          errorCode: error instanceof Error ? error.constructor.name : "unknown"
        });
        this.logFailure("password_reset_email_failed", requestId, error);
      }
      return false;
    }
  }

  @Post("verify-email")
  @HttpCode(200)
  @RateLimit("AUTH_STRICT")
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() request: IdentityRequest) {
    try {
      await this.emailVerification.confirm(dto.token);
      this.securityLogger.success("email_verified", request.requestId);
      return { data: { success: true } };
    } catch (error: unknown) {
      this.logFailure("email_verification_failed", request.requestId, error);
      throw error;
    }
  }

  @Post("resend-verification")
  @HttpCode(200)
  @RateLimit("AUTH_STRICT")
  @UseGuards(JwtAccessGuard)
  async resendVerification(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest
  ) {
    const verificationToken = await this.sendVerificationEmail(
      principal.userId.toString(),
      request.requestId
    );
    return { data: { success: true, ...(verificationToken ? { emailVerificationToken: verificationToken } : {}) } };
  }

  /**
   * Best-effort: verification email delivery never blocks or fails the caller's request. In
   * production the token must be delivered by the email that was sent; in development/test (no SMTP
   * transport) it is returned to the caller so the flow is usable end-to-end, mirroring forgot-password.
   */
  private async sendVerificationEmail(userId: string, requestId: string): Promise<string | undefined> {
    try {
      const issued = await this.emailVerification.issueToken(userId);
      if (!issued) return undefined;
      const verifyUrl = `${this.securityConfig.webAppUrl}/verify-email?token=${issued.token}`;
      if (this.emailService.isConfigured()) {
        await this.emailService.sendMail({
          to: issued.email,
          subject: "Verify your email address",
          text: `Verify your email address by visiting: ${verifyUrl}\n\nThis link expires in 24 hours.`
        });
      }
      this.securityLogger.success("email_verification_sent", requestId);
      return this.securityConfig.allowDevelopmentImplementations ? issued.token : undefined;
    } catch (error: unknown) {
      if (!(error instanceof EmailNotConfiguredError)) {
        this.logFailure("email_verification_send_failed", requestId, error);
      }
      return undefined;
    }
  }

  private logFailure(event: string, requestId: string, error: unknown): void {
    const category = error instanceof IdentityApplicationError ? error.code : "internal";
    this.securityLogger.failure(event, requestId, category);
  }

  private setRefreshCookie(response: IdentityResponse, refreshToken: string): void {
    setRefreshTokenCookie(
      response,
      refreshToken,
      this.securityConfig.browserAuth,
      this.securityConfig.refreshToken.expiresInSeconds
    );
  }
}
