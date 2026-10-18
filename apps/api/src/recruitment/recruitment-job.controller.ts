import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { CreateJobDto, ListJobsDto, ParseJobDescriptionDto, UpdateJobDto } from "./recruitment.dto";
import { RecruitmentJobService } from "./recruitment-job.service";
import { RecruitmentParsingService } from "./recruitment-parsing.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";

function org(p: AuthenticatedPrincipal): string {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal): string {
  return p.userId.toString();
}

/** AI Recruitment Consultant — internal-only (never customer-facing, never AI-Receptionist-routable; see
 * plugins/recruitment-consultant/plugin.json). Mirrors LeadController's exact guard/decorator pattern. */
@ApiTags("Recruitment")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("recruitment/jobs")
export class RecruitmentJobController {
  constructor(
    private readonly jobs: RecruitmentJobService,
    private readonly parsing: RecruitmentParsingService,
    private readonly prisma: PrismaService
  ) {}

  @Get() @RequirePermission("recruitment.jobs.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: ListJobsDto
  ) {
    return this.jobs.list(org(p), query);
  }

  @Get(":id") @RequirePermission("recruitment.jobs.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.jobs.get(org(p), id);
  }

  @Post() @RequirePermission("recruitment.jobs.create") create(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: CreateJobDto
  ) {
    return this.jobs.create(org(p), user(p), dto);
  }

  @Patch(":id") @RequirePermission("recruitment.jobs.update") update(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateJobDto
  ) {
    return this.jobs.update(org(p), id, dto);
  }

  @Post(":id/close") @RequirePermission("recruitment.jobs.delete") close(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.jobs.close(org(p), id);
  }

  /** Phase 2's JD-parsing assist — the recruiter must still confirm/edit before CreateJobDto persists
   * anything; this endpoint only ever returns a suggestion, never writes to the database. */
  @Post("parse-description") @RequirePermission("recruitment.jobs.create") async parseDescription(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: ParseJobDescriptionDto
  ) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { organizationId: org(p), slug: "recruitment-consultant", deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("RECRUITMENT_CONSULTANT_NOT_INSTALLED");
    return this.parsing.parseJobDescription(org(p), plugin.id, dto.text);
  }
}
