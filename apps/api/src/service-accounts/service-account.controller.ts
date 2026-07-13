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
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  CreateApiKeyDto,
  CreateServiceAccountDto,
  ServiceAccountQueryDto,
  UpdateServiceAccountDto
} from "./service-account.dto";
import { ServiceAccountService } from "./service-account.service";
@ApiTags("Service Accounts")
@ApiBearerAuth()
@Controller("service-accounts")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class ServiceAccountController {
  constructor(
    private readonly service: ServiceAccountService,
    private readonly audit: AuditEventLogger
  ) {}
  @Get() @RequirePermission("service_accounts.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: ServiceAccountQueryDto
  ) {
    return this.service.list(p.organizationId.toString(), q);
  }
  @Post() @RequirePermission("service_accounts.create") async create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateServiceAccountDto,
    @Req() req: IdentityRequest
  ) {
    const value = await this.service.create(p.organizationId.toString(), p.userId.toString(), dto);
    this.log("SERVICE_ACCOUNT_CREATED", req, p, value.id);
    return value;
  }
  @Get(":id") @RequirePermission("service_accounts.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.service.get(p.organizationId.toString(), id);
  }
  @Patch(":id") @RequirePermission("service_accounts.update") async update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateServiceAccountDto,
    @Req() req: IdentityRequest
  ) {
    const value = await this.service.update(p.organizationId.toString(), id, dto);
    this.log(
      dto.status === "DISABLED"
        ? "SERVICE_ACCOUNT_DISABLED"
        : dto.status === "ACTIVE"
          ? "SERVICE_ACCOUNT_ENABLED"
          : "SERVICE_ACCOUNT_UPDATED",
      req,
      p,
      id
    );
    return value;
  }
  @Delete(":id") @RequirePermission("service_accounts.delete") @HttpCode(204) async remove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    await this.service.remove(p.organizationId.toString(), id, p.userId.toString());
    this.log("SERVICE_ACCOUNT_DELETED", req, p, id);
  }
  @Get(":id/api-keys") @RequirePermission("api_keys.read") keys(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.service.keys(p.organizationId.toString(), id);
  }
  @Post(":id/api-keys") @RequirePermission("api_keys.create") async createKey(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: CreateApiKeyDto,
    @Req() req: IdentityRequest
  ) {
    const value = await this.service.createKey(
      p.organizationId.toString(),
      id,
      p.userId.toString(),
      dto
    );
    this.log("API_KEY_CREATED", req, p, value.apiKey.id);
    return value;
  }
  @Post(":id/api-keys/:keyId/revoke") @RequirePermission("api_keys.revoke") async revoke(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("keyId", new ParseUUIDPipe()) keyId: string,
    @Req() req: IdentityRequest
  ) {
    const value = await this.service.revoke(
      p.organizationId.toString(),
      id,
      keyId,
      p.userId.toString()
    );
    this.log("API_KEY_REVOKED", req, p, keyId);
    return value;
  }
  @Post(":id/api-keys/:keyId/rotate") @RequirePermission("api_keys.rotate") async rotate(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("keyId", new ParseUUIDPipe()) keyId: string,
    @Req() req: IdentityRequest
  ) {
    const value = await this.service.rotate(
      p.organizationId.toString(),
      id,
      keyId,
      p.userId.toString()
    );
    this.log("API_KEY_ROTATED", req, p, keyId);
    return value;
  }
  private log(event: string, req: IdentityRequest, p: AuthenticatedPrincipal, targetId: string) {
    this.audit.record(event, req.requestId, {
      organizationId: p.organizationId.toString(),
      userId: p.userId.toString(),
      targetId
    });
  }
}
