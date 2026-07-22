import { Body, Controller, Get, HttpCode, Inject, Patch, Req, UseGuards } from "@nestjs/common";
import {
  GET_ORGANIZATION,
  type GetOrganizationHandler
} from "../../application/handlers/get-organization";
import {
  GET_ORGANIZATION_SETTINGS,
  type GetOrganizationSettingsHandler
} from "../../application/handlers/get-organization-settings";
import {
  UPDATE_ORGANIZATION,
  type UpdateOrganizationHandler
} from "../../application/handlers/update-organization";
import {
  UPDATE_ORGANIZATION_SETTINGS,
  type UpdateOrganizationSettingsHandler
} from "../../application/handlers/update-organization-settings";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { CurrentPrincipal } from "./current-principal.decorator";
import type { IdentityRequest } from "./request-context";
import { JwtAccessGuard } from "./jwt-access.guard";
import { AuditEventLogger } from "./audit-event.logger";
import { UpdateOrganizationDto, UpdateOrganizationSettingsDto } from "./organizations.dto";

@Controller("organizations")
@UseGuards(JwtAccessGuard)
export class OrganizationsController {
  constructor(
    @Inject(GET_ORGANIZATION)
    private readonly getOrganization: GetOrganizationHandler,
    @Inject(UPDATE_ORGANIZATION)
    private readonly updateOrganization: UpdateOrganizationHandler,
    @Inject(GET_ORGANIZATION_SETTINGS)
    private readonly getOrganizationSettings: GetOrganizationSettingsHandler,
    @Inject(UPDATE_ORGANIZATION_SETTINGS)
    private readonly updateOrganizationSettings: UpdateOrganizationSettingsHandler,
    private readonly auditLogger: AuditEventLogger
  ) {}

  @Get("me")
  async me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { data: await this.getOrganization.execute(principal) };
  }

  @Patch("me")
  @HttpCode(200)
  async updateMe(
    @Body() dto: UpdateOrganizationDto,
    @Req() request: IdentityRequest,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const result = await this.updateOrganization.execute(principal, { name: dto.name });
    this.auditLogger.record("ORGANIZATION_UPDATED", request.requestId, {
      organizationId: result.organization.id
    });
    return { data: result };
  }

  @Get("me/settings")
  async meSettings(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { data: await this.getOrganizationSettings.execute(principal) };
  }

  @Patch("me/settings")
  @HttpCode(200)
  async updateMeSettings(
    @Body() dto: UpdateOrganizationSettingsDto,
    @Req() request: IdentityRequest,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const command: {
      timezone?: string;
      currency?: string;
      locale?: string;
    } = {};
    if (dto.timezone !== undefined) {
      command.timezone = dto.timezone;
    }
    if (dto.currency !== undefined) {
      command.currency = dto.currency;
    }
    if (dto.locale !== undefined) {
      command.locale = dto.locale;
    }
    const result = await this.updateOrganizationSettings.execute(principal, {
      ...command
    });
    this.auditLogger.record("ORGANIZATION_SETTINGS_UPDATED", request.requestId, {
      organizationId: result.organizationSetting.organizationId
    });
    return { data: result };
  }
}
