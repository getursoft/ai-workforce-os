/** Krevia CRM API — tenant-scoped, authenticated, RBAC-gated. Mirrors TravelEmployeeController/
 * InteractionController's exact guard/decorator pattern. Also the future Android/iOS app's surface: no
 * dashboard-only assumptions (no cookies, no server-rendered state) — bearer-token JSON in, JSON out. */
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { LeadService } from "./lead.service";
import { AddLeadNoteDto, AssignLeadDto, CreateLeadDto, ListLeadsDto, UpdateLeadDto } from "./lead.dto";

function org(p: AuthenticatedPrincipal): string {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal): string {
  return p.userId.toString();
}

@ApiTags("Krevia CRM")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("leads")
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Get("summary") @RequirePermission("leads.read") summary(@CurrentPrincipal() p: AuthenticatedPrincipal) {
    return this.leads.summary(org(p));
  }

  @Get() @RequirePermission("leads.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: ListLeadsDto
  ) {
    return this.leads.list(org(p), query);
  }

  @Get("reference/:referenceId") @RequirePermission("leads.read") getByReference(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("referenceId") referenceId: string
  ) {
    return this.leads.getByReference(org(p), referenceId);
  }

  @Get(":id") @RequirePermission("leads.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.leads.get(org(p), id);
  }

  @Get(":id/activity") @RequirePermission("leads.read") activity(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.leads.activity(org(p), id);
  }

  @Post() @RequirePermission("leads.create") create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateLeadDto
  ) {
    return this.leads.create(org(p), user(p), dto);
  }

  @Patch(":id") @RequirePermission("leads.update") update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLeadDto
  ) {
    return this.leads.update(org(p), user(p), id, dto);
  }

  @Post(":id/notes") @RequirePermission("leads.notes") addNote(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: AddLeadNoteDto
  ) {
    return this.leads.addNote(org(p), user(p), id, dto.note);
  }

  @Post(":id/assign") @RequirePermission("leads.assign") assign(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: AssignLeadDto
  ) {
    return this.leads.assign(org(p), user(p), id, dto.assignedToUserId ?? null);
  }
}
