import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma, type QueueCategory } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";
import { QUEUE } from "../queue/queue.tokens";
import type { BackgroundQueue } from "../queue/queue.types";
import { RecruitmentCandidateQueryService, type RecruitmentCandidateQuery } from "./recruitment-candidate-query.service";
import { sanitizeSpreadsheetCell, csvEscape } from "./recruitment-resume.service";

/** Phase 11's full export-field catalog — every column a recruiter can choose to include. The default
 * set (used when a request doesn't specify `fieldSelection`) is every field except the two truly
 * sensitive ones already covered by their own permission check (mobileNumber/email are still included by
 * default here since the export permission itself already gates all of them — see requestExport's
 * `recruitment.candidates.export` check — but kept as a named, individually-selectable field per Phase
 * 11's "Allow field selection before export"). */
export const EXPORT_FIELDS = [
  "jobId",
  "jobTitle",
  "resumeId",
  "candidateName",
  "mobileNumber",
  "email",
  "currentCity",
  "currentState",
  "currentCountry",
  "preferredLocations",
  "willingToRelocate",
  "noticePeriod",
  "totalExperience",
  "relevantExperience",
  "extractedSkills",
  "matchedSkills",
  "missingSkills",
  "atsScore",
  "aiRecommendation",
  "recruiterDecision",
  "applicationStatus",
  "evaluationDate"
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

const FIELD_HEADERS: Record<ExportField, string> = {
  jobId: "Job ID",
  jobTitle: "Job Title",
  resumeId: "Resume ID",
  candidateName: "Candidate Name",
  mobileNumber: "Mobile Number",
  email: "Email Address",
  currentCity: "Current City",
  currentState: "Current State",
  currentCountry: "Current Country",
  preferredLocations: "Preferred Locations",
  willingToRelocate: "Willing to Relocate",
  noticePeriod: "Notice Period",
  totalExperience: "Total Experience",
  relevantExperience: "Relevant Experience",
  extractedSkills: "Extracted Skills",
  matchedSkills: "Matched Skills",
  missingSkills: "Missing Skills",
  atsScore: "ATS Score",
  aiRecommendation: "AI Recommendation",
  recruiterDecision: "Recruiter Decision",
  applicationStatus: "Application Status",
  evaluationDate: "Evaluation Date"
};

export interface RequestExportInput {
  scope: "ALL_AUTHORIZED" | "FILTERED" | "SELECTED" | "CURRENT_JOB" | "CROSS_JOB";
  format: "CSV" | "XLSX";
  jobId?: string;
  filters?: RecruitmentCandidateQuery;
  fieldSelection?: ExportField[];
  selectedApplicationIds?: string[];
}

type ExportableApplication = Awaited<ReturnType<RecruitmentCandidateQueryService["query"]>>["items"][number];

const EXPORT_EXPIRY_HOURS = 24;
/** A safety cap on synchronous generation. Anything at or under this is generated and uploaded inline
 * within the request (Phase 11); anything larger is marked QUEUED and drained by
 * RecruitmentExportWorkerService (Sprint 7.17 Phase 3) via the same PostgresQueueAdapter every other
 * background job in this codebase uses — not a second, bespoke polling mechanism. */
export const SYNCHRONOUS_ROW_CAP = 5000;
/** Sprint 7.17 (Phase 3) — the worker's per-page fetch size: bounds how many fully-joined application rows
 * are ever resident in memory at once while streaming a 10k/25k-row export, regardless of total row count. */
export const EXPORT_PAGE_SIZE = 100;

/** Builds one export row as plain field values — shared verbatim between the synchronous path below and
 * RecruitmentExportWorkerService's streaming path, so a large export can never produce different column
 * values than a small one for the same filters. */
export function buildExportRow(
  app: ExportableApplication,
  fields: readonly ExportField[]
): Array<string | number | Date | null> {
  const values: Record<ExportField, string | number | Date | null> = {
    jobId: app.job.jobCode,
    jobTitle: app.job.title,
    resumeId: app.resume.resumeCode,
    candidateName: app.candidate.fullName ?? "Not Available",
    mobileNumber: app.candidate.mobileNumber ?? "Not Available",
    email: app.candidate.email ?? "Not Available",
    currentCity: app.candidate.currentCity ?? "",
    currentState: app.candidate.currentState ?? "",
    currentCountry: app.candidate.currentCountry ?? "",
    preferredLocations: app.candidate.preferredWorkLocations?.join("; ") ?? "",
    willingToRelocate:
      app.candidate.willingToRelocate === null ? "Unknown" : app.candidate.willingToRelocate ? "Yes" : "No",
    noticePeriod: app.candidate.noticePeriod ?? "",
    totalExperience: app.resume.totalExperienceYears ?? "",
    relevantExperience: app.resume.relevantExperienceYears ?? "",
    extractedSkills: app.resume.extractedSkills?.join("; ") ?? "",
    matchedSkills: (app.evaluation?.matchedSkills as string[] | null)?.join("; ") ?? "",
    missingSkills: (app.evaluation?.missingSkills as string[] | null)?.join("; ") ?? "",
    atsScore: app.evaluation?.matchScore ?? null,
    aiRecommendation: app.aiRecommendation ?? "",
    recruiterDecision: app.recruiterDecision,
    applicationStatus: app.applicationStatus,
    evaluationDate: app.evaluation?.evaluatedAt ?? null
  };
  return fields.map((f) => values[f]);
}

export function exportFieldHeaders(fields: readonly ExportField[]): string[] {
  return fields.map((f) => FIELD_HEADERS[f]);
}

@Injectable()
export class RecruitmentExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: RecruitmentCandidateQueryService,
    @Inject(QUEUE) private readonly queue: BackgroundQueue,
    @Inject(OBJECT_STORAGE) @Optional() private readonly objectStorage?: ObjectStorageService
  ) {}

  async requestExport(organizationId: string, requestedByUserId: string, input: RequestExportInput) {
    if ((input.scope === "CURRENT_JOB" || input.scope === "FILTERED") && !input.jobId && input.scope === "CURRENT_JOB") {
      throw new ForbiddenException("RECRUITMENT_EXPORT_JOB_ID_REQUIRED");
    }
    const job = await this.prisma.recruitmentExportJob.create({
      data: {
        organizationId,
        requestedByUserId,
        jobId: input.jobId ?? null,
        scope: input.scope,
        format: input.format,
        filters: (input.filters as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        fieldSelection: (input.fieldSelection as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        selectedIds: (input.selectedApplicationIds as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        status: "PROCESSING"
      }
    });

    try {
      // Counting-only probe — never loads full joined rows just to decide sync vs. async (the previous
      // version called resolveApplications() for this, which for SELECTED with tens of thousands of ids,
      // or for an unbounded filter, defeated the whole point of a row cap by materializing everything
      // anyway before checking its length).
      const rowCount = await this.countApplications(organizationId, input);
      if (rowCount > SYNCHRONOUS_ROW_CAP) {
        await this.prisma.recruitmentExportJob.update({
          where: { id: job.id },
          data: { status: "QUEUED", rowCount }
        });
        // Sprint 7.17 (Phase 3) — drained by RecruitmentExportWorkerService via the SAME durable queue
        // every other background job in this codebase uses. dedupeKey makes a retried HTTP request (e.g.
        // a client double-submit) not enqueue a second worker run for the same export job row.
        await this.queue.publish({
          organizationId,
          category: "RECRUITMENT_EXPORTS" as QueueCategory,
          refType: "RecruitmentExportJob",
          refId: job.id,
          dedupeKey: `recruitment-export:${job.id}`,
          maxAttempts: 5,
          visibilityMs: 10 * 60_000
        });
        return { exportJobId: job.id, status: "QUEUED" as const, rowCount };
      }

      const rows = await this.resolveApplications(organizationId, input);
      const fields = input.fieldSelection?.length ? input.fieldSelection : EXPORT_FIELDS;
      const { buffer, contentType, extension } = await this.renderFile(rows, fields, input.format);

      if (!this.objectStorage) throw new Error("RECRUITMENT_OBJECT_STORAGE_UNAVAILABLE");
      const downloadToken = randomBytes(24).toString("base64url");
      const storageKey = `recruitment/exports/${job.id}.${extension}`;
      await this.objectStorage.putObject({ organizationId, key: storageKey, buffer, contentType });

      const expiresAt = new Date(Date.now() + EXPORT_EXPIRY_HOURS * 60 * 60 * 1000);
      await this.prisma.recruitmentExportJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          rowCount: rows.length,
          storageKey,
          downloadToken,
          expiresAt,
          completedAt: new Date()
        }
      });
      return { exportJobId: job.id, status: "COMPLETED" as const, rowCount: rows.length, downloadToken };
    } catch (error) {
      await this.prisma.recruitmentExportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorMessage: (error instanceof Error ? error.message : "Export failed").slice(0, 500) }
      });
      throw error;
    }
  }

  /** Sprint 7.17 — export revocation audit: scoped to BOTH the requesting organization (tenant isolation,
   * pre-existing) AND the original requester (`requestedByUserId`), not just anyone in the org who
   * happens to also hold `recruitment.candidates.export`. Nothing in this module's design ever documented
   * org-wide shared visibility into another user's export job, so a same-org, different-user request is
   * treated the same as a cross-tenant one: a 404, not a 403 — it never confirms the job exists. */
  async getExportStatus(organizationId: string, exportJobId: string, requestedByUserId: string) {
    const job = await this.prisma.recruitmentExportJob.findFirst({ where: { id: exportJobId, organizationId, requestedByUserId } });
    if (!job) throw new NotFoundException("RECRUITMENT_EXPORT_JOB_NOT_FOUND");
    return job;
  }

  /** Sprint 7.17 (Phase 3) — cooperative cancellation. Only a job still QUEUED or PROCESSING can be
   * cancelled; the worker checks for this status between pages (never mid-page) and stops rather than
   * finishing the file. A COMPLETED/FAILED/EXPIRED job is already past the point cancellation means
   * anything for. Scoped to the original requester — see getExportStatus's note on ownership. */
  async cancelExport(organizationId: string, exportJobId: string, requestedByUserId: string) {
    const job = await this.prisma.recruitmentExportJob.findFirst({ where: { id: exportJobId, organizationId, requestedByUserId } });
    if (!job) throw new NotFoundException("RECRUITMENT_EXPORT_JOB_NOT_FOUND");
    if (job.status !== "QUEUED" && job.status !== "PROCESSING") {
      throw new ForbiddenException("RECRUITMENT_EXPORT_NOT_CANCELLABLE");
    }
    return this.prisma.recruitmentExportJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
  }

  /** Phase 11: "Never place sensitive export files behind public permanent URLs" — every download goes
   * through this method, which validates the token, checks expiry, and only then mints a short-lived
   * signed URL from object storage (never a stored/static link). Scoped to the original requester — see
   * getExportStatus's note on ownership; the live PermissionGuard on the route re-verifies the caller
   * still holds recruitment.candidates.export on every request, this adds the per-resource ownership
   * check the guard can't express. */
  async getDownloadUrl(organizationId: string, exportJobId: string, downloadToken: string, requestedByUserId: string): Promise<string> {
    const job = await this.prisma.recruitmentExportJob.findFirst({ where: { id: exportJobId, organizationId, requestedByUserId } });
    if (!job || job.status !== "COMPLETED" || !job.storageKey) throw new NotFoundException("RECRUITMENT_EXPORT_NOT_READY");
    if (job.downloadToken !== downloadToken) throw new ForbiddenException("RECRUITMENT_EXPORT_TOKEN_INVALID");
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      await this.prisma.recruitmentExportJob.update({ where: { id: job.id }, data: { status: "EXPIRED" } });
      throw new ForbiddenException("RECRUITMENT_EXPORT_LINK_EXPIRED");
    }
    if (!this.objectStorage) throw new Error("RECRUITMENT_OBJECT_STORAGE_UNAVAILABLE");
    await this.prisma.recruitmentExportJob.update({
      where: { id: job.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() }
    });
    return this.objectStorage.getSignedDownloadUrl(organizationId, job.storageKey, 300);
  }

  /** Row count only — never materializes the joined rows themselves. For SELECTED, the id list the client
   * sent already bounds the count with no query needed. */
  private async countApplications(organizationId: string, input: RequestExportInput): Promise<number> {
    if (input.scope === "SELECTED") return input.selectedApplicationIds?.length ?? 0;
    const query: RecruitmentCandidateQuery = {
      ...(input.filters ?? {}),
      ...(input.scope === "CURRENT_JOB" && input.jobId ? { jobId: input.jobId } : {}),
      limit: 1
    };
    const result = await this.queries.query(organizationId, query);
    return result.totalCount;
  }

  private async resolveApplications(organizationId: string, input: RequestExportInput) {
    if (input.scope === "SELECTED") {
      if (!input.selectedApplicationIds?.length) return [];
      return this.prisma.recruitmentApplication.findMany({
        where: { organizationId, id: { in: input.selectedApplicationIds.slice(0, SYNCHRONOUS_ROW_CAP) } },
        include: { candidate: true, resume: true, evaluation: true, job: true }
      });
    }
    // ALL_AUTHORIZED / FILTERED / CURRENT_JOB / CROSS_JOB all route through the SAME shared query service
    // that the website/WhatsApp/iOS use — Phase 11: "Apply the exact same server-side filters used by the
    // UI" is true by construction, not by re-implementing the filter logic here.
    //
    // RecruitmentCandidateQueryService clamps `limit` to its own MAX_LIMIT (100) regardless of what's
    // requested here — a single call with limit: SYNCHRONOUS_ROW_CAP silently returned only the first 100
    // rows for anything over that, a real truncation bug this sprint's scale benchmark caught (a 1,000-
    // and 5,000-row export both came back as exactly 100 rows). Looping pages up to the cap, exactly like
    // RecruitmentExportWorkerService's streaming path, is the fix — and the two no longer disagree.
    const baseQuery: RecruitmentCandidateQuery = {
      ...(input.filters ?? {}),
      ...(input.scope === "CURRENT_JOB" && input.jobId ? { jobId: input.jobId } : {}),
      limit: EXPORT_PAGE_SIZE
    };
    const rows: ExportableApplication[] = [];
    let cursor: string | undefined;
    do {
      // includeContact: true — recruitment.candidates.export is its own, already-broader permission that
      // has always covered contact fields by design (Sprint 7.16); this is a deliberate opt-out of the
      // query service's Phase 5 contact masking, not an oversight.
      const result = await this.queries.query(organizationId, { ...baseQuery, ...(cursor ? { cursor } : {}) }, { includeContact: true });
      rows.push(...result.items);
      cursor = result.nextCursor ?? undefined;
    } while (cursor && rows.length < SYNCHRONOUS_ROW_CAP);
    return rows;
  }

  private async renderFile(
    rows: ExportableApplication[],
    fields: readonly ExportField[],
    format: "CSV" | "XLSX"
  ): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
    const header = exportFieldHeaders(fields);
    const dataRows: Array<Array<string | number | Date | null>> = rows.map((app) => buildExportRow(app, fields));

    if (format === "CSV") {
      const stringRows = dataRows.map((row) =>
        row.map((cell) => (cell instanceof Date ? cell.toISOString() : (cell?.toString() ?? "")))
      );
      const csv = [header, ...stringRows].map((row) => row.map(csvEscape).join(",")).join("\n");
      return { buffer: Buffer.from(csv, "utf8"), contentType: "text/csv", extension: "csv" };
    }

    const XLSX = await import("xlsx");
    const sanitizedRows = dataRows.map((row) =>
      row.map((cell) => (typeof cell === "string" ? sanitizeSpreadsheetCell(cell) : cell))
    );
    const sheet = XLSX.utils.aoa_to_sheet([header, ...sanitizedRows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Candidates");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return {
      buffer,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx"
    };
  }
}
