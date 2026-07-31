import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { UpdateEmployeeConfigurationDto } from "../employees/employee.dto";
import { HrEmployeeService } from "./hr-employee.service";

@ApiTags("HR Employee")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("hr-employee")
export class HrEmployeeController {
  constructor(private readonly hr: HrEmployeeService) {}

  @Get(":pluginInstallationId/configuration")
  @RequirePermission("hr.config.read")
  configuration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.hr.configuration(org(p), pluginInstallationId);
  }

  @Patch(":pluginInstallationId/configuration")
  @RequirePermission("hr.config.update")
  updateConfiguration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Body() dto: UpdateEmployeeConfigurationDto
  ) {
    return this.hr.updateConfiguration(org(p), user(p), req.requestId, pluginInstallationId, dto);
  }

  @Get(":pluginInstallationId/conversations/:conversationId/state")
  @RequirePermission("agents.conversations.read")
  state(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.hr.state(org(p), pluginInstallationId, conversationId);
  }

  @Post(":pluginInstallationId/conversations/:conversationId/reset")
  @RequirePermission("hr.conversation.reset")
  resetConversation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.hr.resetConversation(org(p), user(p), req.requestId, pluginInstallationId, conversationId);
  }

  @Get(":pluginInstallationId/tickets")
  @RequirePermission("hr.tickets.read")
  tickets(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.hr.tickets(org(p), pluginInstallationId);
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
