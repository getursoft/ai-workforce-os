import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { UpdateEmployeeConfigurationDto } from "../employees/employee.dto";
import { FinanceEmployeeService } from "./finance-employee.service";

@ApiTags("Finance Employee")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("finance-employee")
export class FinanceEmployeeController {
  constructor(private readonly finance: FinanceEmployeeService) {}

  @Get(":pluginInstallationId/configuration")
  @RequirePermission("finance.config.read")
  configuration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.finance.configuration(org(p), pluginInstallationId);
  }

  @Patch(":pluginInstallationId/configuration")
  @RequirePermission("finance.config.update")
  updateConfiguration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Body() dto: UpdateEmployeeConfigurationDto
  ) {
    return this.finance.updateConfiguration(org(p), user(p), req.requestId, pluginInstallationId, dto);
  }

  @Get(":pluginInstallationId/conversations/:conversationId/state")
  @RequirePermission("agents.conversations.read")
  state(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.finance.state(org(p), pluginInstallationId, conversationId);
  }

  @Post(":pluginInstallationId/conversations/:conversationId/reset")
  @RequirePermission("finance.conversation.reset")
  resetConversation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string,
    @Param("conversationId", new ParseUUIDPipe()) conversationId: string
  ) {
    return this.finance.resetConversation(org(p), user(p), req.requestId, pluginInstallationId, conversationId);
  }

  @Get(":pluginInstallationId/records")
  @RequirePermission("finance.records.read")
  records(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("pluginInstallationId", new ParseUUIDPipe()) pluginInstallationId: string
  ) {
    return this.finance.records(org(p), pluginInstallationId);
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
