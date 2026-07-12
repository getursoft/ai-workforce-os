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
  AddTeamMemberDto,
  CreateTeamDto,
  TeamMemberQueryDto,
  TeamQueryDto,
  UpdateTeamDto,
  UpdateTeamMemberDto
} from "./team.dto";
import { TeamService } from "./team.service";

@ApiTags("Teams")
@ApiBearerAuth()
@Controller("teams")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class TeamController {
  constructor(
    private readonly teams: TeamService,
    private readonly audit: AuditEventLogger
  ) {}
  @Post() @RequirePermission("TEAM_CREATE") async create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateTeamDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.teams.create(p.organizationId.toString(), dto);
    this.record("TEAM_CREATED", req, p, result.id);
    return result;
  }
  @Get() @RequirePermission("TEAM_READ") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: TeamQueryDto
  ) {
    return this.teams.list(p.organizationId.toString(), q);
  }
  @Get(":id") @RequirePermission("TEAM_READ") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.teams.get(p.organizationId.toString(), id);
  }
  @Patch(":id") @RequirePermission("TEAM_UPDATE") async update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTeamDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.teams.update(p.organizationId.toString(), id, dto);
    this.record("TEAM_UPDATED", req, p, id);
    return result;
  }
  @Delete(":id") @RequirePermission("TEAM_DELETE") @HttpCode(204) async remove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: IdentityRequest
  ) {
    await this.teams.remove(p.organizationId.toString(), id);
    this.record("TEAM_DELETED", req, p, id);
  }
  @Get(":id/members") @RequirePermission("TEAM_READ") members(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() q: TeamMemberQueryDto
  ) {
    return this.teams.members(p.organizationId.toString(), id, q);
  }
  @Post(":id/members") @RequirePermission("TEAM_MEMBER_ADD") async add(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: AddTeamMemberDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.teams.addMember(
      p.organizationId.toString(),
      id,
      dto.userId,
      dto.role
    );
    this.record("TEAM_MEMBER_ADDED", req, p, dto.userId);
    return result;
  }
  @Patch(":id/members/:userId") @RequirePermission("TEAM_MEMBER_UPDATE") async updateMember(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("userId", new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateTeamMemberDto,
    @Req() req: IdentityRequest
  ) {
    const result = await this.teams.updateMember(p.organizationId.toString(), id, userId, dto.role);
    this.record("TEAM_MEMBER_UPDATED", req, p, userId);
    return result;
  }
  @Delete(":id/members/:userId")
  @RequirePermission("TEAM_MEMBER_REMOVE")
  @HttpCode(204)
  async removeMember(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("userId", new ParseUUIDPipe()) userId: string,
    @Req() req: IdentityRequest
  ) {
    await this.teams.removeMember(p.organizationId.toString(), id, userId);
    this.record("TEAM_MEMBER_REMOVED", req, p, userId);
  }
  private record(event: string, req: IdentityRequest, p: AuthenticatedPrincipal, targetId: string) {
    this.audit.record(event, req.requestId, {
      organizationId: p.organizationId.toString(),
      userId: p.userId.toString(),
      targetId
    });
  }
}
