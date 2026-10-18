import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { CorrectCandidateLocationDto, ListCandidatesDto, ReviewApplicationDto, RetryResumeDto } from "./recruitment.dto";
import { RecruitmentResumeService, type UploadedResumeFile } from "./recruitment-resume.service";

function org(p: AuthenticatedPrincipal): string {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal): string {
  return p.userId.toString();
}

@ApiTags("Recruitment")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("recruitment")
export class RecruitmentResumeController {
  constructor(
    private readonly resumes: RecruitmentResumeService,
    private readonly authorization: AuthorizationService
  ) {}

  @Post("jobs/:jobId/resumes/batch")
  @RequirePermission("recruitment.resumes.upload")
  @UseInterceptors(FilesInterceptor("files", 200))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["files"],
      properties: { files: { type: "array", items: { type: "string", format: "binary" } } }
    }
  })
  async uploadBatch(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Req() request: Request & { files?: UploadedResumeFile[] }
  ) {
    return this.resumes.createBatch(org(p), jobId, user(p), request.files ?? []);
  }

  @Get("batches/:batchId") @RequirePermission("recruitment.resumes.read") batchStatus(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("batchId", new ParseUUIDPipe()) batchId: string
  ) {
    return this.resumes.batchStatus(org(p), batchId);
  }

  @Post("batches/:batchId/retry") @RequirePermission("recruitment.resumes.upload") retry(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("batchId", new ParseUUIDPipe()) batchId: string,
    @Body() dto: RetryResumeDto
  ) {
    return this.resumes.retryFailed(org(p), batchId, dto.resumeIds);
  }

  @Get("jobs/:jobId/candidates") @RequirePermission("recruitment.candidates.review") async candidates(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Query() query: ListCandidatesDto
  ) {
    const includeContact = await this.authorization.hasPermission(user(p), org(p), "recruitment.candidates.contact");
    return this.resumes.listCandidates(org(p), jobId, query, includeContact);
  }

  @Get("jobs/:jobId/export") @RequirePermission("recruitment.candidates.export") async exportCsv(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    // Typed to only what's actually called — avoids depending on `express`'s type declarations (not a
    // direct dependency of this package; only @nestjs/platform-express is), same as every other
    // `@Res()`/`@Req()` usage in this codebase typing against the minimal shape it needs.
    @Res() res: { setHeader(name: string, value: string): void; send(body: string): void }
  ) {
    const csv = await this.resumes.exportCandidatesCsv(org(p), jobId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="job-${jobId}-candidates.csv"`);
    res.send(csv);
  }

  @Get("jobs/:jobId/export.xlsx") @RequirePermission("recruitment.candidates.export") async exportXlsx(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Res() res: { setHeader(name: string, value: string): void; send(body: Buffer): void }
  ) {
    const xlsx = await this.resumes.exportCandidatesXlsx(org(p), jobId);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="job-${jobId}-candidates.xlsx"`);
    res.send(xlsx);
  }

  /** Sprint 7.17 Phase 5 remaining-steps audit: this endpoint returned the full unmasked candidate
   * (mobileNumber/email) to any `recruitment.candidates.review` holder — the same gap already fixed for
   * search/list, missed here on the first pass. `recruitment.candidates.contact` is now required. */
  @Get("applications/:applicationId") @RequirePermission("recruitment.candidates.review") async getApplication(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("applicationId", new ParseUUIDPipe()) applicationId: string
  ) {
    const includeContact = await this.authorization.hasPermission(user(p), org(p), "recruitment.candidates.contact");
    return this.resumes.getApplication(org(p), applicationId, includeContact);
  }

  @Post("applications/:applicationId/review") @RequirePermission("recruitment.candidates.review") review(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("applicationId", new ParseUUIDPipe()) applicationId: string,
    @Body() dto: ReviewApplicationDto
  ) {
    return this.resumes.reviewApplication(org(p), applicationId, user(p), dto);
  }

  @Get("resumes/:resumeId/download-url") @RequirePermission("recruitment.resumes.read") async downloadUrl(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("resumeId", new ParseUUIDPipe()) resumeId: string
  ) {
    return { url: await this.resumes.resumeDownloadUrl(org(p), resumeId) };
  }

  /** Sprint 7.16 Phase 5 — re-queues resumes parsed under an older extraction version so existing
   * candidates get location fields without re-uploading. Requires the same permission as a fresh upload
   * since it schedules real (billable) LLM extraction work. */
  @Post("candidates/backfill-locations") @RequirePermission("recruitment.resumes.upload") backfillLocations(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.resumes.backfillLocations(org(p));
  }

  @Post("candidates/:candidateId/location") @RequirePermission("recruitment.candidates.review") correctLocation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("candidateId", new ParseUUIDPipe()) candidateId: string,
    @Body() dto: CorrectCandidateLocationDto
  ) {
    return this.resumes.correctCandidateLocation(org(p), candidateId, dto);
  }
}
