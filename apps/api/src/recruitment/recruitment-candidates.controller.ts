import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AdvancedCandidateQueryDto, RecordCallEventDto, RequestExportDto, SaveFilterPresetDto } from "./recruitment.dto";
import { RecruitmentCandidateQueryService, type RecruitmentCandidateQuery } from "./recruitment-candidate-query.service";
import { RecruitmentExportService, type ExportField } from "./recruitment-export.service";
import { NotFoundException } from "@nestjs/common";

/** Sprint 7.17 (Phase 5): reporting one of these specifically requires `recruitment.candidates.call`, not
 * just `.contact` — a recruiter can be permitted to SEE a number without being permitted to place/log a
 * call against it (the two security test cases "Recruiter without contact permission" and "Recruiter
 * without calling permission" are deliberately independent). */
const CALL_ACTION_STATUSES = new Set(["CALL_ACTION_REQUESTED", "CALL_LINK_OPENED", "CALL_CANCELLED"]);

function org(p: AuthenticatedPrincipal): string {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal): string {
  return p.userId.toString();
}

/** Maps the validated DTO's string dates to real Date objects for the query service — kept as a free
 * function so the website, and later the WhatsApp natural-language layer, both normalize identically. */
export function toCandidateQuery(dto: AdvancedCandidateQueryDto): RecruitmentCandidateQuery {
  const { uploadDateFrom, uploadDateTo, evaluationDateFrom, evaluationDateTo, ...rest } = dto;
  return {
    ...rest,
    ...(uploadDateFrom ? { uploadDateFrom: new Date(uploadDateFrom) } : {}),
    ...(uploadDateTo ? { uploadDateTo: new Date(uploadDateTo) } : {}),
    ...(evaluationDateFrom ? { evaluationDateFrom: new Date(evaluationDateFrom) } : {}),
    ...(evaluationDateTo ? { evaluationDateTo: new Date(evaluationDateTo) } : {})
  };
}

@ApiTags("Recruitment")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("recruitment/candidates")
export class RecruitmentCandidatesController {
  constructor(
    private readonly queries: RecruitmentCandidateQueryService,
    private readonly exports: RecruitmentExportService,
    private readonly authorization: AuthorizationService,
    private readonly prisma: PrismaService
  ) {}

  /** Phase 6 — the one search endpoint website/iOS both call. WhatsApp's menu-driven and
   * natural-language-driven filtering (Phase 7/8) call RecruitmentCandidateQueryService directly from the
   * WhatsApp module rather than over HTTP, but build the exact same RecruitmentCandidateQuery shape.
   *
   * Sprint 7.17 (Phase 5): `recruitment.candidates.review` alone grants seeing the match/score/skills —
   * `mobileNumber`/`email` require the separate `recruitment.candidates.contact` permission, checked here
   * and enforced inside the query service itself (never left to the caller to remember to mask). */
  @Post("search") @RequirePermission("recruitment.candidates.review") async search(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: AdvancedCandidateQueryDto
  ) {
    const includeContact = await this.authorization.hasPermission(user(p), org(p), "recruitment.candidates.contact");
    return this.queries.query(org(p), toCandidateQuery(dto), { includeContact });
  }

  @Post("export") @RequirePermission("recruitment.candidates.export") requestExport(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: RequestExportDto
  ) {
    return this.exports.requestExport(org(p), user(p), {
      scope: dto.scope,
      format: dto.format,
      ...(dto.jobId ? { jobId: dto.jobId } : {}),
      ...(dto.filters ? { filters: toCandidateQuery(dto.filters) } : {}),
      ...(dto.fieldSelection ? { fieldSelection: dto.fieldSelection as ExportField[] } : {}),
      ...(dto.selectedApplicationIds ? { selectedApplicationIds: dto.selectedApplicationIds } : {})
    });
  }

  @Get("export/:exportJobId") @RequirePermission("recruitment.candidates.export") exportStatus(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("exportJobId", new ParseUUIDPipe()) exportJobId: string
  ) {
    return this.exports.getExportStatus(org(p), exportJobId, user(p));
  }

  @Post("export/:exportJobId/cancel") @RequirePermission("recruitment.candidates.export") cancelExport(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("exportJobId", new ParseUUIDPipe()) exportJobId: string
  ) {
    return this.exports.cancelExport(org(p), exportJobId, user(p));
  }

  @Get("export/:exportJobId/download") @RequirePermission("recruitment.candidates.export") async download(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("exportJobId", new ParseUUIDPipe()) exportJobId: string,
    @Req() req: { query: { token?: string } }
  ) {
    const token = req.query.token ?? "";
    return { url: await this.exports.getDownloadUrl(org(p), exportJobId, token, user(p)) };
  }

  @Post("filter-presets") @RequirePermission("recruitment.candidates.review") async savePreset(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: SaveFilterPresetDto
  ) {
    return this.prisma.recruitmentFilterPreset.upsert({
      where: { userId_name: { userId: user(p), name: dto.name } },
      create: { organizationId: org(p), userId: user(p), name: dto.name, filters: dto.filters as unknown as object },
      update: { filters: dto.filters as unknown as object }
    });
  }

  @Get("filter-presets") @RequirePermission("recruitment.candidates.review") listPresets(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.prisma.recruitmentFilterPreset.findMany({
      where: { organizationId: org(p), userId: user(p) },
      orderBy: { createdAt: "desc" }
    });
  }

  @Delete("filter-presets/:presetId") @RequirePermission("recruitment.candidates.review") async deletePreset(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("presetId", new ParseUUIDPipe()) presetId: string
  ) {
    const preset = await this.prisma.recruitmentFilterPreset.findFirst({
      where: { id: presetId, organizationId: org(p), userId: user(p) }
    });
    if (!preset) throw new NotFoundException("RECRUITMENT_FILTER_PRESET_NOT_FOUND");
    await this.prisma.recruitmentFilterPreset.delete({ where: { id: presetId } });
    return { deleted: true };
  }

  /** Sprint 7.17 (Phase 5) — the calling-audit event sink shared by every manual-calling client (website
   * tel: link, iOS tap-to-call). WhatsApp's own click-to-call path already writes this same table
   * directly from RecruitmentWhatsAppMenuService.showCandidateDetail; this endpoint is the equivalent
   * entry point for the other two surfaces so all three produce one consistent, append-only audit trail.
   *
   * `recruitment.candidates.contact` alone covers CONTACT_VIEWED (merely being shown the number).
   * CALL_ACTION_REQUESTED / CALL_LINK_OPENED / CALL_CANCELLED additionally require
   * `recruitment.candidates.call` — a recruiter can be authorized to see a number without being
   * authorized to place/log a call against it. Never accepts a provider-attested status (CALL_CONNECTED
   * etc.) from the client — RecordCallEventDto's own enum makes that impossible to express. */
  @Post(":candidateId/call-log") @RequirePermission("recruitment.candidates.contact") async logCallAccess(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("candidateId", new ParseUUIDPipe()) candidateId: string,
    @Body() body: RecordCallEventDto
  ) {
    if (CALL_ACTION_STATUSES.has(body.status)) {
      const canCall = await this.authorization.hasPermission(user(p), org(p), "recruitment.candidates.call");
      if (!canCall) throw new ForbiddenException("RECRUITMENT_CALLING_PERMISSION_REQUIRED");
    }
    const candidate = await this.prisma.recruitmentCandidate.findFirst({ where: { id: candidateId, organizationId: org(p) } });
    if (!candidate) throw new NotFoundException("RECRUITMENT_CANDIDATE_NOT_FOUND");

    // Duplicate-call protection: a double-tap/double-click submitting the identical event for the same
    // candidate+application within a short window collapses onto the existing row instead of spamming
    // the audit trail with near-duplicate entries.
    const recent = await this.prisma.recruitmentCallLog.findFirst({
      where: {
        organizationId: org(p),
        candidateId,
        initiatedByUserId: user(p),
        status: body.status,
        applicationId: body.applicationId ?? null,
        createdAt: { gte: new Date(Date.now() - 5000) }
      },
      orderBy: { createdAt: "desc" }
    });
    if (recent) return recent;

    return this.prisma.recruitmentCallLog.create({
      data: {
        organizationId: org(p),
        candidateId,
        jobId: body.jobId ?? null,
        applicationId: body.applicationId ?? null,
        initiatedByUserId: user(p),
        channel: body.channel ?? "MANUAL_CLICK_TO_CALL",
        platform: body.platform ?? null,
        status: body.status,
        notes: body.notes ?? null
      }
    });
  }
}
