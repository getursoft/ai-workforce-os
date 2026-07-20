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
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  ConnectorEventDto,
  ConnectorEventQueryDto,
  ConnectorInstallationQueryDto,
  ConnectorPageDto,
  InstallConnectorDto,
  UpdateConnectorCapabilitiesDto,
  UpdateConnectorConfigurationDto,
  UpdateConnectorCredentialsDto,
  UpdateConnectorDto
} from "./connector.dto";
import { ConnectorService } from "./connector.service";

@ApiTags("Connectors")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller()
export class ConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  @Get("connectors") @RequirePermission("connector.read") catalogue(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.connectors.catalogue(org(p));
  }
  @Get("connectors/:id") @RequirePermission("connector.read") definition(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string
  ) {
    return this.connectors.definitionById(org(p), id);
  }
  @Get("connector-installations") @RequirePermission("connector.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: ConnectorInstallationQueryDto
  ) {
    return this.connectors.list(org(p), query);
  }
  @Post("connector-installations") @RequirePermission("connector.install") install(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Body() dto: InstallConnectorDto
  ) {
    return this.connectors.install(org(p), user(p), req.requestId, dto);
  }
  @Get("connector-installations/:id") @RequirePermission("connector.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connectors.get(org(p), id);
  }
  @Patch("connector-installations/:id") @RequirePermission("connector.update") update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateConnectorDto
  ) {
    return this.connectors.update(org(p), user(p), req.requestId, id, dto);
  }
  @Delete("connector-installations/:id")
  @RequirePermission("connector.remove")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    await this.connectors.remove(org(p), user(p), req.requestId, id);
  }
  @Patch("connector-installations/:id/configuration")
  @RequirePermission("connector.configure")
  configuration(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateConnectorConfigurationDto
  ) {
    return this.connectors.updateConfiguration(org(p), user(p), req.requestId, id, dto);
  }
  @Patch("connector-installations/:id/credentials")
  @RequirePermission("connector.authenticate")
  credentials(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateConnectorCredentialsDto
  ) {
    return this.connectors.updateCredentials(org(p), user(p), req.requestId, id, dto);
  }
  @Delete("connector-installations/:id/credentials")
  @RequirePermission("connector.authenticate")
  removeCredentials(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connectors.removeCredentials(org(p), user(p), req.requestId, id);
  }
  @Get("connector-installations/:id/capabilities")
  @RequirePermission("connector.read")
  capabilities(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connectors.capabilities(org(p), id);
  }
  @Patch("connector-installations/:id/capabilities")
  @RequirePermission("connector.configure")
  updateCapabilities(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateConnectorCapabilitiesDto
  ) {
    return this.connectors.updateCapabilities(org(p), user(p), req.requestId, id, dto);
  }
  @Get("connector-installations/:id/tools") @RequirePermission("connector.read") tools(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.connectors.tools(org(p), id);
  }
  @Get("connector-installations/:id/executions")
  @RequirePermission("connector.execution.read")
  executions(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: ConnectorPageDto
  ) {
    return this.connectors.executions(org(p), id, query);
  }
  @Get("connector-installations/:id/events") @RequirePermission("connector.event.read") events(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: ConnectorEventQueryDto
  ) {
    return this.connectors.events(org(p), id, query);
  }
  @Get("connector-installations/:id/audit") @RequirePermission("connector.audit.read") audits(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: ConnectorPageDto
  ) {
    return this.connectors.audits(org(p), id, query);
  }
  @Post("connector-installations/:id/events") @RequirePermission("connector.update") ingest(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: ConnectorEventDto
  ) {
    return this.connectors.ingest(org(p), user(p), req.requestId, id, dto);
  }

  @Post("connector-installations/:id/enable") @RequirePermission("connector.enable") enable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "enable");
  }
  @Post("connector-installations/:id/disable") @RequirePermission("connector.disable") disable(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "disable");
  }
  @Post("connector-installations/:id/test") @RequirePermission("connector.test") test(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "test");
  }
  @Post("connector-installations/:id/health") @RequirePermission("connector.health") health(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "health");
  }
  @Post("connector-installations/:id/disconnect")
  @RequirePermission("connector.disconnect")
  disconnect(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "disconnect");
  }
  @Post("connector-installations/:id/reconnect")
  @RequirePermission("connector.authenticate")
  reconnect(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.action(p, req, id, "reconnect");
  }
  private action(
    p: AuthenticatedPrincipal,
    req: IdentityRequest,
    id: string,
    action: "enable" | "disable" | "test" | "health" | "disconnect" | "reconnect"
  ) {
    return this.connectors.lifecycle(org(p), user(p), req.requestId, id, action);
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
