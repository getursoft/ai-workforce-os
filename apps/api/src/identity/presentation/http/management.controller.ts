import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { ManagementService } from "../../application/services/management.service";
import { CurrentPrincipal } from "./current-principal.decorator";
import { JwtAccessGuard } from "./jwt-access.guard";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./permission.decorators";
import {
  AcceptInvitationDto,
  AssignPermissionsDto,
  AssignRolesDto,
  CreateInvitationDto,
  CreateRoleDto,
  CreateUserDto,
  PageDto,
  ResetUserPasswordDto,
  UpdateRoleDto,
  UpdateUserDto
} from "./management.dto";
import { AuditEventLogger } from "./audit-event.logger";
import type { IdentityRequest } from "./request-context";

const ids = (principal: AuthenticatedPrincipal) => ({
  org: principal.organizationId.toString(),
  user: principal.userId.toString()
});

@Controller()
@UseGuards(JwtAccessGuard, PermissionGuard)
export class ManagementController {
  constructor(
    private readonly service: ManagementService,
    private readonly audit: AuditEventLogger
  ) {}
  private audited(
    event: string,
    request: IdentityRequest,
    principal: AuthenticatedPrincipal,
    targetId?: string
  ) {
    this.audit.record(event, request.requestId, {
      organizationId: principal.organizationId.toString(),
      userId: principal.userId.toString(),
      ...(targetId ? { targetId } : {})
    });
  }
  @Get("users") @RequirePermission("users.read") listUsers(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: PageDto
  ) {
    return this.service.listUsers(ids(p).org, q);
  }
  @Get("users/:id") @RequirePermission("users.read") getUser(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string
  ) {
    return this.service.getUser(ids(p).org, id);
  }
  @Post("users") @RequirePermission("users.write") async createUser(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateUserDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.createUser(ids(p).org, dto);
    this.audited("USER_CREATED", req, p, result.id);
    return result;
  }
  @Patch("users/:id") @RequirePermission("users.write") async updateUser(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.updateUser(ids(p).org, id, ids(p).user, dto);
    this.audited("USER_UPDATED", req, p, id);
    return result;
  }
  @Post("users/:id/reset-password") @RequirePermission("users.write") async resetPassword(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() dto: ResetUserPasswordDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.resetUserPassword(ids(p).org, id, ids(p).user, dto.password);
    this.audited("USER_PASSWORD_RESET", req, p, id);
    return result;
  }
  @Delete("users/:id") @RequirePermission("users.delete") @HttpCode(204) async deleteUser(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Req() req: IdentityRequest
  ) {
    await this.service.deleteUser(ids(p).org, id, ids(p).user);
    this.audited("USER_DELETED", req, p, id);
  }
  @Patch("users/:id/roles") @RequirePermission("users.write") async assignRoles(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() dto: AssignRolesDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.assignRoles(ids(p).org, id, ids(p).user, dto.roleIds);
    this.audited("USER_ROLES_CHANGED", req, p, id);
    return result;
  }
  @Get("roles") @RequirePermission("roles.read") listRoles(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.service.listRoles(ids(p).org);
  }
  @Post("roles") @RequirePermission("roles.write") async createRole(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateRoleDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.createRole(ids(p).org, dto);
    this.audited("ROLE_CREATED", req, p, result.id);
    return result;
  }
  @Patch("roles/:id") @RequirePermission("roles.write") async updateRole(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.updateRole(ids(p).org, id, dto);
    this.audited("ROLE_UPDATED", req, p, id);
    return result;
  }
  @Delete("roles/:id") @RequirePermission("roles.write") @HttpCode(204) async deleteRole(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Req() req: IdentityRequest
  ) {
    await this.service.deleteRole(ids(p).org, id);
    this.audited("ROLE_DELETED", req, p, id);
  }
  @Patch("roles/:id/permissions") @RequirePermission("roles.write") async assignPermissions(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Body() dto: AssignPermissionsDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.assignPermissions(ids(p).org, id, dto.permissionIds);
    this.audited("ROLE_PERMISSIONS_CHANGED", req, p, id);
    return result;
  }
  @Get("permissions") @RequirePermission("roles.read") listPermissions() {
    return this.service.listPermissions();
  }
  @Get("invitations") @RequirePermission("invitations.read") listInvitations(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.service.listInvitations(ids(p).org);
  }
  @Post("invitations") @RequirePermission("invitations.write") async invite(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateInvitationDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.invite(ids(p).org, ids(p).user, dto.email, dto.roleIds);
    this.audited("INVITATION_CREATED", req, p, result.invitation.id);
    return result;
  }
  @Post("invitations/:id/resend") @RequirePermission("invitations.write") async resend(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.resend(ids(p).org, id, ids(p).user);
    this.audited("INVITATION_RESENT", req, p, id);
    return result;
  }
  @Post("invitations/:id/revoke") @RequirePermission("invitations.write") async revoke(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id") id: string,
    @Req() req: IdentityRequest
  ) {
    const result = await this.service.revoke(ids(p).org, id);
    this.audited("INVITATION_REVOKED", req, p, id);
    return result;
  }
}

@Controller("invitations")
export class InvitationAcceptanceController {
  constructor(private readonly service: ManagementService) {}
  @Post("accept") accept(@Body() dto: AcceptInvitationDto) {
    return this.service.accept(dto.token, dto);
  }
}
