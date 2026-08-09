import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength, IsOptional } from "class-validator";
import { IsUUID } from "class-validator";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { SWITCH_ORGANIZATION, type SwitchOrganizationHandler } from "../../application/handlers/switch-organization";
import type { IdentityRequest, IdentityResponse } from "./request-context";
import { PlatformService } from "../../application/services/platform.service";
import { CurrentPrincipal } from "./current-principal.decorator";
import { JwtAccessGuard } from "./jwt-access.guard";
import { PlatformOwnerGuard } from "../../infrastructure/security/platform-owner.guard";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../../infrastructure/security/security-config";
import { setRefreshTokenCookie } from "./browser-cookie";
import { AuditEventLogger } from "./audit-event.logger";
import { RateLimit } from "../../../security/rate-limit.decorator";

export class CreateOrganizationDto {
  @IsString() @IsNotEmpty() @MinLength(2) @MaxLength(120) name!: string;
  /** Optional: onboard the new company's first owner login in the same call. */
  @IsOptional() @IsEmail() @MaxLength(254) ownerEmail?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) ownerFirstName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) ownerLastName?: string;
  @IsOptional() @IsString() @MinLength(12) @MaxLength(128) ownerPassword?: string;
}

export class SwitchOrganizationDto {
  @IsUUID() organizationId!: string;
}

export class SuspendOrganizationDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class AddSupportNoteDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) body!: string;
}

/**
 * Platform-owner console: list/create organizations and switch the owner's session into any
 * organization. Every route is guarded by PlatformOwnerGuard — only the universal platform owner
 * (SecurityConfig.platformOwnerEmail) may reach them.
 */
@ApiTags("Platform")
@ApiBearerAuth()
@Controller("platform")
@UseGuards(JwtAccessGuard, PlatformOwnerGuard)
@RateLimit("ADMIN_API")
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    @Inject(SWITCH_ORGANIZATION)
    private readonly switchOrganization: SwitchOrganizationHandler,
    @Inject(SECURITY_CONFIG) private readonly securityConfig: SecurityConfig,
    private readonly audit: AuditEventLogger
  ) {}

  @Get("organizations")
  async listOrganizations() {
    return { data: await this.platform.listOrganizations() };
  }

  @Post("organizations")
  async createOrganization(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: CreateOrganizationDto,
    @Req() request: IdentityRequest
  ) {
    const result = await this.platform.createOrganization({
      name: dto.name,
      actorId: principal.userId.toString(),
      ...(dto.ownerEmail ? { ownerEmail: dto.ownerEmail } : {}),
      ...(dto.ownerFirstName ? { ownerFirstName: dto.ownerFirstName } : {}),
      ...(dto.ownerLastName ? { ownerLastName: dto.ownerLastName } : {}),
      ...(dto.ownerPassword ? { ownerPassword: dto.ownerPassword } : {})
    });
    this.audit.record(
      dto.ownerEmail ? "ORGANIZATION_ONBOARDED" : "ORGANIZATION_CREATED",
      request.requestId,
      {
        organizationId: result.organization.id,
        userId: principal.userId.toString()
      }
    );
    return { data: result };
  }

  @Post("organizations/:id/switch")
  async switch(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) response: IdentityResponse
  ) {
    const result = await this.switchOrganization.execute(principal, { organizationId: id });
    setRefreshTokenCookie(
      response,
      result.tokens.refreshToken,
      this.securityConfig.browserAuth,
      this.securityConfig.refreshToken.expiresInSeconds
    );
    this.audit.record("ORGANIZATION_SWITCHED", request.requestId, {
      organizationId: id,
      userId: principal.userId.toString()
    });
    return { data: result };
  }

  // Sprint 5.0 Phase 13: platform-admin console — suspend/reactivate, support notes, and a tenant-safe
  // operational summary (counts and status only, never raw prompts/documents/memory/secrets).

  @Get("organizations/:id/summary")
  async operationalSummary(@Param("id", new ParseUUIDPipe()) id: string) {
    return { data: await this.platform.operationalSummary(id) };
  }

  @Post("organizations/:id/suspend")
  async suspendOrganization(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: SuspendOrganizationDto,
    @Req() request: IdentityRequest
  ) {
    const result = await this.platform.suspendOrganization(id, principal.userId.toString(), dto.reason);
    this.audit.record("ORGANIZATION_SUSPENDED", request.requestId, { organizationId: id, userId: principal.userId.toString() });
    return { data: result };
  }

  @Post("organizations/:id/reactivate")
  async reactivateOrganization(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: IdentityRequest
  ) {
    const result = await this.platform.reactivateOrganization(id, principal.userId.toString());
    this.audit.record("ORGANIZATION_REACTIVATED", request.requestId, { organizationId: id, userId: principal.userId.toString() });
    return { data: result };
  }

  @Get("organizations/:id/support-notes")
  async listSupportNotes(@Param("id", new ParseUUIDPipe()) id: string) {
    return { data: await this.platform.listSupportNotes(id) };
  }

  @Post("organizations/:id/support-notes")
  async addSupportNote(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: AddSupportNoteDto
  ) {
    return { data: await this.platform.addSupportNote(id, principal.userId.toString(), dto.body) };
  }
}
