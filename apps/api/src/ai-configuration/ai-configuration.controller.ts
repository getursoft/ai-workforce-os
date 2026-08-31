import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AiProfilePurpose } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { AiProviderConnectionService } from "./ai-provider-connection.service";
import { AiModelProfileService } from "./ai-model-profile.service";
import { EmployeeAiAssignmentService } from "./employee-ai-assignment.service";
import { AiConfigurationBackfillService } from "./ai-configuration-backfill.service";
import {
  CreateAiModelProfileDto,
  CreateAiProviderConnectionDto,
  UpdateAiModelProfileDto,
  UpdateAiProviderConnectionDto,
  UpdateOrganizationAiDefaultsDto,
  UpsertEmployeeAiProfileAssignmentDto
} from "./ai-configuration.dto";

@ApiTags("AI Configuration")
@ApiBearerAuth()
@Controller("ai-configuration")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class AiConfigurationController {
  constructor(
    private readonly connections: AiProviderConnectionService,
    private readonly profiles: AiModelProfileService,
    private readonly assignments: EmployeeAiAssignmentService,
    private readonly backfill: AiConfigurationBackfillService
  ) {}

  @Get("connections") @RequirePermission("ai.provider.read") listConnections(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.connections.list(p.organizationId.toString());
  }

  @Get("connections/:id") @RequirePermission("ai.provider.read") getConnection(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connections.get(p.organizationId.toString(), id);
  }

  @Post("connections") @RequirePermission("ai.provider.manage") createConnection(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateAiProviderConnectionDto
  ) {
    return this.connections.create(p.organizationId.toString(), p.userId.toString(), dto);
  }

  @Patch("connections/:id") @RequirePermission("ai.provider.manage") updateConnection(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAiProviderConnectionDto
  ) {
    return this.connections.update(p.organizationId.toString(), id, dto);
  }

  @Delete("connections/:id") @RequirePermission("ai.provider.manage") deleteConnection(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connections.delete(p.organizationId.toString(), id);
  }

  @Post("connections/:id/test") @RequirePermission("ai.provider.manage") testConnection(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connections.testConnection(p.organizationId.toString(), id);
  }

  @Get("connections/:id/models") @RequirePermission("ai.provider.read") discoverModels(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connections.discoverModels(p.organizationId.toString(), id);
  }

  @Get("profiles") @RequirePermission("ai.profile.read") listProfiles(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("purpose") purpose?: string
  ) {
    return this.profiles.list(p.organizationId.toString(), purpose);
  }

  @Get("profiles/:id") @RequirePermission("ai.profile.read") getProfile(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.profiles.get(p.organizationId.toString(), id);
  }

  @Post("profiles") @RequirePermission("ai.profile.manage") createProfile(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateAiModelProfileDto
  ) {
    return this.profiles.create(p.organizationId.toString(), dto);
  }

  @Patch("profiles/:id") @RequirePermission("ai.profile.manage") updateProfile(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAiModelProfileDto
  ) {
    return this.profiles.update(p.organizationId.toString(), id, dto);
  }

  @Delete("profiles/:id") @RequirePermission("ai.profile.manage") deleteProfile(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.profiles.delete(p.organizationId.toString(), id);
  }

  @Get("employees/:pluginId/assignments") @RequirePermission("ai.assignment.read") listAssignments(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginId", new ParseUUIDPipe()) pluginId: string
  ) {
    return this.assignments.listForEmployee(p.organizationId.toString(), pluginId);
  }

  @Put("employees/:pluginId/assignments") @RequirePermission("ai.assignment.manage") upsertAssignment(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginId", new ParseUUIDPipe()) pluginId: string,
    @Body() dto: UpsertEmployeeAiProfileAssignmentDto
  ) {
    return this.assignments.upsert(p.organizationId.toString(), pluginId, dto);
  }

  @Delete("employees/:pluginId/assignments/:purpose")
  @RequirePermission("ai.assignment.manage")
  removeAssignment(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginId", new ParseUUIDPipe()) pluginId: string,
    @Param("purpose") purpose: AiProfilePurpose
  ) {
    return this.assignments.remove(p.organizationId.toString(), pluginId, purpose);
  }

  @Get("organization-defaults") @RequirePermission("ai.assignment.read") getOrganizationDefaults(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.assignments.getOrganizationDefaults(p.organizationId.toString());
  }

  @Patch("organization-defaults") @RequirePermission("ai.assignment.manage") updateOrganizationDefaults(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: UpdateOrganizationAiDefaultsDto
  ) {
    return this.assignments.updateOrganizationDefaults(p.organizationId.toString(), dto);
  }

  /** Scoped to the caller's own organization only — never platform-wide via API, to avoid a
   *  cross-tenant footgun. Platform-wide backfill (all organizations at once) is a deliberately
   *  separate, operator-run script, not an HTTP endpoint any organization admin can trigger. */
  @Post("backfill") @RequirePermission("ai.provider.manage") runBackfill(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.backfill.run(p.organizationId.toString());
  }
}
