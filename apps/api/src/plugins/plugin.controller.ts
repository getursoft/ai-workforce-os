import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  InstallPluginDto,
  PluginQueryDto,
  UpdatePluginConfigurationDto,
  UpdatePluginDto
} from "./plugin.dto";
import { PluginService } from "./plugin.service";

@ApiTags("Plugins")
@ApiBearerAuth()
@Controller("plugins")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class PluginController {
  constructor(
    private readonly plugins: PluginService,
    private readonly audit: AuditEventLogger
  ) {}
  @Post("install") @RequirePermission("plugin.install") async install(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: InstallPluginDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.plugins.install(
      p.organizationId.toString(),
      p.userId.toString(),
      dto
    );
    this.record("PLUGIN_INSTALLED", req, p, result.id);
    return result;
  }
  @Get() @RequirePermission("plugin.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: PluginQueryDto
  ) {
    return this.plugins.list(p.organizationId.toString(), q);
  }
  @Get("available") @RequirePermission("plugin.read") available(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.plugins.available(p.organizationId.toString());
  }
  @Get(":id") @RequirePermission("plugin.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.plugins.get(p.organizationId.toString(), id);
  }
  @Patch(":id") @RequirePermission("plugin.update") async update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePluginDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.plugins.update(p.organizationId.toString(), id, dto);
    this.record("PLUGIN_UPDATED", req, p, id);
    return result;
  }
  @Delete(":id") @RequirePermission("plugin.delete") @HttpCode(204) async remove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    await this.plugins.remove(p.organizationId.toString(), id);
    this.record("PLUGIN_REMOVED", req, p, id);
  }
  @Post(":id/enable") @RequirePermission("plugin.update") async enable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    const result = await this.plugins.enable(p.organizationId.toString(), id);
    this.record("PLUGIN_ENABLED", req, p, id);
    return result;
  }
  @Patch(":id/enable") @RequirePermission("plugin.update") enablePatch(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    return this.enable(p, id, req);
  }
  @Post(":id/disable") @RequirePermission("plugin.update") async disable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    const result = await this.plugins.disable(p.organizationId.toString(), id);
    this.record("PLUGIN_DISABLED", req, p, id);
    return result;
  }
  @Patch(":id/disable") @RequirePermission("plugin.update") disablePatch(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    return this.disable(p, id, req);
  }
  @Get(":id/configuration") @RequirePermission("plugin.read") configuration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.plugins.configuration(p.organizationId.toString(), id);
  }
  @Patch(":id/configuration") @RequirePermission("plugin.update") async updateConfiguration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePluginConfigurationDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.plugins.updateConfiguration(
      p.organizationId.toString(),
      p.userId.toString(),
      id,
      dto
    );
    this.record("PLUGIN_CONFIGURATION_UPDATED", req, p, id);
    return result;
  }
  @Get(":id/health") @RequirePermission("plugin.read") health(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.plugins.health(p.organizationId.toString(), id);
  }
  @Post(":id/health") @RequirePermission("plugin.read") healthPost(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.plugins.health(p.organizationId.toString(), id);
  }
  private record(event: string, req: IdentityRequest, p: AuthenticatedPrincipal, targetId: string) {
    this.audit.record(event, req.requestId, {
      organizationId: p.organizationId.toString(),
      userId: p.userId.toString(),
      targetId
    });
  }
}
