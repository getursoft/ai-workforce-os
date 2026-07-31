import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { UpdateEmployeeConfigurationDto } from "../employees/employee.dto";
import { LegalEmployeeService } from "./legal-employee.service";

@ApiTags("Legal Employee")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("legal-employee")
export class LegalEmployeeController {
  constructor(private readonly legal: LegalEmployeeService) {}

  @Get(":pluginInstallationId/configuration")
  @RequirePermission("legal.config.read")
  configuration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.legal.configuration(org(p), pluginInstallationId);
  }

  @Patch(":pluginInstallationId/configuration")
  @RequirePermission("legal.config.update")
  updateConfiguration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Body() dto: UpdateEmployeeConfigurationDto
  ) {
    return this.legal.updateConfiguration(org(p), user(p), req.requestId, pluginInstallationId, dto);
  }

  @Get(":pluginInstallationId/conversations/:conversationId/state")
  @RequirePermission("agents.conversations.read")
  state(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.legal.state(org(p), pluginInstallationId, conversationId);
  }

  @Post(":pluginInstallationId/conversations/:conversationId/reset")
  @RequirePermission("legal.conversation.reset")
  resetConversation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.legal.resetConversation(org(p), user(p), req.requestId, pluginInstallationId, conversationId);
  }

  @Get(":pluginInstallationId/notices")
  @RequirePermission("legal.notices.read")
  notices(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.legal.notices(org(p), pluginInstallationId);
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
