import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { OBJECT_STORAGE, sanitizeObjectKey, type ObjectStorageService } from "../storage/object-storage.types";
import type { ListCandidatesDto, ReviewApplicationDto } from "./recruitment.dto";
import { RecruitmentParsingService } from "./recruitment-parsing.service";

export interface UploadedResumeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword"
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class RecruitmentResumeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) @Optional() private readonly objectStorage?: ObjectStorageService
  ) {}

  /** Phase 3's full upload workflow up through "Background processing begins" — parsing/matching/scoring
   * happen asynchronously (see RecruitmentBatchProcessor), never inside this request. Returns per-file
   * acceptance results immediately so a 100-file batch never blocks on provider calls. */
  async createBatch(
    organizationId: string,
    jobId: string,
    uploadedByUserId: string,
    files: UploadedResumeFile[],
    sourceChannel: "WEBSITE" | "WHATSAPP" = "WEBSITE"
  ) {
    const job = await this.prisma.recruitmentJob.findFirst({ where: { id: jobId, organizationId } });
    if (!job) throw new NotFoundException("RECRUITMENT_JOB_NOT_FOUND");
    if (!files.length) throw new BadRequestException("RECRUITMENT_NO_FILES_PROVIDED");

    const batch = await this.prisma.recruitmentUploadBatch.create({
      data: {
        organizationId,
        jobId,
        uploadedByUserId,
        totalFiles: files.length,
        queuedFiles: files.length,
        status: "QUEUED",
        sourceChannel
      }
    });

    const results: Array<{ fileName: string; status: string; resumeId?: string; error?: string }> = [];
    for (const file of files) {
      try {
        results.push(await this.ingestOneFile(organizationId, jobId, batch.id, file));
      } catch (error) {
        results.push({
          fileName: file.originalname,
          status: "FAILED",
          error: error instanceof Error ? error.message : "Upload failed"
        });
      }
    }
    const failedCount = results.filter((r) => r.status === "FAILED").length;
    if (failedCount > 0) {
      await this.prisma.recruitmentUploadBatch.update({
        where: { id: batch.id },
        data: {
          failedFiles: failedCount,
          queuedFiles: files.length - failedCount,
          status: failedCount === files.length ? "FAILED" : "PROCESSING"
        }
      });
    } else {
      await this.prisma.recruitmentUploadBatch.update({ where: { id: batch.id }, data: { status: "PROCESSING" } });
    }
    return { batchId: batch.id, totalFiles: files.length, results };
  }

  /** Validates, hashes (duplicate detection), stores, and creates the Resume + Application rows for one
   * file — the resume itself is never re-parsed/re-scored here; `RecruitmentBatchProcessor` does that
   * asynchronously once this returns. Idempotent: the same file re-uploaded against the same job (same
   * fileHash -> same Resume row, `@@unique([jobId, resumeId])` on Application) reuses both rows instead
   * of duplicating them (Phase 11). */
  private async ingestOneFile(organizationId: string, jobId: string, batchId: string, file: UploadedResumeFile) {
    if (!SUPPORTED_MIME_TYPES.has(file.mimetype))
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}. Only PDF and DOCX are supported.`);
    if (file.size > MAX_FILE_BYTES) throw new BadRequestException("File exceeds the 10MB size limit.");
    if (!file.buffer?.length) throw new BadRequestException("Empty file.");
    // File-signature (magic-byte) check — a declared Content-Type is attacker-controlled and proves
    // nothing by itself; this is the real, feasible security baseline in this environment (no malware/AV
    // scanning infrastructure exists here — see the session's own completion report for that blocker).
    if (!hasValidFileSignature(file.mimetype, file.buffer))
      throw new BadRequestException("File content does not match its declared type (failed signature check).");

    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    let resume = await this.prisma.recruitmentResume.findFirst({ where: { organizationId, fileHash } });

    if (!resume) {
      const resumeCode = await this.nextResumeCode(organizationId);
      let storageKey = `local/${randomUUID()}`;
      if (this.objectStorage) {
        const key = sanitizeObjectKey(`recruitment-resumes/${organizationId}/${resumeCode}-${file.originalname}`);
        const meta = await this.objectStorage.putObject({
          organizationId,
          key,
          buffer: file.buffer,
          contentType: file.mimetype
        });
        storageKey = meta.key;
      }
      resume = await this.prisma.recruitmentResume.create({
        data: {
          organizationId,
          resumeCode,
          fileName: file.originalname,
          storageKey,
          fileSizeBytes: file.size,
          fileHash,
          parsingStatus: "QUEUED",
          uploadBatchId: batchId
        }
      });
    }

    const existingApplication = await this.prisma.recruitmentApplication.findUnique({
      where: { jobId_resumeId: { jobId, resumeId: resume.id } }
    });
    if (!existingApplication) {
      // A placeholder candidate row — RecruitmentBatchProcessor replaces/merges it once parsing extracts
      // a real name/email/phone to dedupe against (Phase 10's "do not unnecessarily create duplicates").
      const candidate = await this.prisma.recruitmentCandidate.create({ data: { organizationId } });
      await this.prisma.recruitmentApplication.create({
        data: { organizationId, jobId, candidateId: candidate.id, resumeId: resume.id }
      });
    }
    return { fileName: file.originalname, status: "QUEUED", resumeId: resume.id };
  }

  async batchStatus(organizationId: string, batchId: string) {
    const batch = await this.prisma.recruitmentUploadBatch.findFirst({ where: { id: batchId, organizationId } });
    if (!batch) throw new NotFoundException("RECRUITMENT_BATCH_NOT_FOUND");
    const [queued, processing, completed, failed] = await Promise.all([
      this.prisma.recruitmentResume.count({ where: { uploadBatchId: batchId, parsingStatus: "QUEUED" } }),
      this.prisma.recruitmentResume.count({ where: { uploadBatchId: batchId, parsingStatus: "PROCESSING" } }),
      this.prisma.recruitmentResume.count({ where: { uploadBatchId: batchId, parsingStatus: "COMPLETED" } }),
      this.prisma.recruitmentResume.count({ where: { uploadBatchId: batchId, parsingStatus: "FAILED" } })
    ]);
    return { ...batch, queued, processing, completed, failed };
  }

  async retryFailed(organizationId: string, batchId: string, resumeIds?: string[]) {
    const batch = await this.prisma.recruitmentUploadBatch.findFirst({ where: { id: batchId, organizationId } });
    if (!batch) throw new NotFoundException("RECRUITMENT_BATCH_NOT_FOUND");
    const result = await this.prisma.recruitmentResume.updateMany({
      where: {
        uploadBatchId: batchId,
        organizationId,
        parsingStatus: "FAILED",
        ...(resumeIds?.length ? { id: { in: resumeIds } } : {})
      },
      data: { parsingStatus: "QUEUED", parsingError: null }
    });
    await this.prisma.recruitmentUploadBatch.update({ where: { id: batchId }, data: { status: "PROCESSING" } });
    return { retried: result.count };
  }

  /** Phase 5's "safe migration/backfill process for previously uploaded resumes" — requeues COMPLETED
   * resumes parsed under an older RecruitmentParsingService.PARSING_VERSION for re-extraction, so their
   * candidate gets location fields without re-uploading. Skips anything without captured extractedText
   * (Phase 5: "Re-extract location only when the necessary source documents are available"), and the
   * batch processor's own human-corrected guard (recruitment-batch-processor.ts's resolveCandidate)
   * prevents this from ever overwriting a recruiter's manual correction. */
  async backfillLocations(organizationId: string, limit = 500) {
    const currentVersion = RecruitmentParsingService.PARSING_VERSION;
    const stale = await this.prisma.recruitmentResume.findMany({
      where: {
        organizationId,
        parsingStatus: "COMPLETED",
        extractedText: { not: null },
        parsingVersion: { not: currentVersion }
      },
      select: { id: true },
      take: limit
    });
    if (stale.length === 0) return { requeued: 0 };
    const result = await this.prisma.recruitmentResume.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { parsingStatus: "QUEUED", retryCount: 0, parsingError: null }
    });
    return { requeued: result.count };
  }

  /** A recruiter's manual correction — permanently exempts this candidate from automatic location
   * overwrite on any future resume parse (Phase 5: "Do not overwrite human-corrected candidate
   * information"), via locationSource = "HUMAN_CORRECTED" (see recruitment-batch-processor.ts). */
  async correctCandidateLocation(
    organizationId: string,
    candidateId: string,
    dto: {
      currentCity?: string | null;
      currentState?: string | null;
      currentCountry?: string | null;
      normalizedRegion?: string | null;
      preferredWorkLocations?: string[] | null;
      willingToRelocate?: boolean | null;
      noticePeriod?: string | null;
    }
  ) {
    const candidate = await this.prisma.recruitmentCandidate.findFirst({ where: { id: candidateId, organizationId } });
    if (!candidate) throw new NotFoundException("RECRUITMENT_CANDIDATE_NOT_FOUND");
    return this.prisma.recruitmentCandidate.update({
      where: { id: candidateId },
      data: {
        ...(dto.currentCity !== undefined ? { currentCity: dto.currentCity } : {}),
        ...(dto.currentState !== undefined ? { currentState: dto.currentState } : {}),
        ...(dto.currentCountry !== undefined ? { currentCountry: dto.currentCountry } : {}),
        ...(dto.normalizedRegion !== undefined ? { normalizedRegion: dto.normalizedRegion } : {}),
        ...(dto.preferredWorkLocations !== undefined
          ? { preferredWorkLocations: dto.preferredWorkLocations ?? [] }
          : {}),
        ...(dto.willingToRelocate !== undefined ? { willingToRelocate: dto.willingToRelocate } : {}),
        ...(dto.noticePeriod !== undefined ? { noticePeriod: dto.noticePeriod } : {}),
        locationSource: "HUMAN_CORRECTED",
        locationExtractedAt: new Date()
      }
    });
  }

  /** Sprint 7.17 (Phase 5): `includeContact` defaults to false (fail-safe) — mobileNumber/email are
   * stripped unless the caller has already verified `recruitment.candidates.contact` and explicitly
   * passes true. This endpoint predates RecruitmentCandidateQueryService and keeps its own query rather
   * than being migrated onto it in this change (out of scope — Phase 10's "Do not replace the working
   * UI" applies equally to not touching a working, separate query path while fixing contact masking). */
  async listCandidates(organizationId: string, jobId: string, query: ListCandidatesDto, includeContact = false) {
    const job = await this.prisma.recruitmentJob.findFirst({ where: { id: jobId, organizationId } });
    if (!job) throw new NotFoundException("RECRUITMENT_JOB_NOT_FOUND");

    const where: Prisma.RecruitmentApplicationWhereInput = {
      organizationId,
      jobId,
      ...(query.aiRecommendation ? { aiRecommendation: query.aiRecommendation } : {}),
      ...(query.recruiterDecision ? { recruiterDecision: query.recruiterDecision } : {}),
      ...(query.search
        ? {
            candidate: {
              OR: [
                { fullName: { contains: query.search, mode: "insensitive" as const } },
                { email: { contains: query.search, mode: "insensitive" as const } },
                { mobileNumber: { contains: query.search } }
              ]
            }
          }
        : {}),
      ...(query.parsingStatus ? { resume: { parsingStatus: query.parsingStatus } } : {}),
      ...(query.minScore !== undefined || query.maxScore !== undefined
        ? {
            evaluation: {
              matchScore: {
                ...(query.minScore !== undefined ? { gte: query.minScore } : {}),
                ...(query.maxScore !== undefined ? { lte: query.maxScore } : {})
              }
            }
          }
        : {})
    };

    const total = await this.prisma.recruitmentApplication.count({ where });
    const orderBy: Prisma.RecruitmentApplicationOrderByWithRelationInput =
      query.sortBy === "createdAt" ? { createdAt: "desc" } : { evaluation: { matchScore: "desc" } };
    const items = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { candidate: true, resume: true, evaluation: true }
    });
    return {
      items: includeContact ? items : items.map((app) => ({ ...app, candidate: { ...app.candidate, mobileNumber: null, email: null } })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize)
    };
  }

  /** Phase 5's exact 12 export columns, shared by both CSV and XLSX so the two formats can never drift.
   * `matchScore`/`evaluatedAt` are kept as real numbers/Dates here (not pre-stringified) so XLSX can give
   * them correct numeric/date cell types (Phase 5: "correct numeric data types") — CSV stringifies them
   * at the join step instead. */
  private async exportRows(organizationId: string, jobId: string) {
    const job = await this.prisma.recruitmentJob.findFirst({ where: { id: jobId, organizationId } });
    if (!job) throw new NotFoundException("RECRUITMENT_JOB_NOT_FOUND");
    const applications = await this.prisma.recruitmentApplication.findMany({
      where: { organizationId, jobId },
      orderBy: { evaluation: { matchScore: "desc" } },
      include: { candidate: true, resume: true, evaluation: true }
    });
    const header = [
      "Job ID",
      "Resume ID",
      "Candidate Name",
      "Mobile Number",
      "Email",
      "ATS Match Score",
      "Matched Skills",
      "Missing Skills",
      "AI Recommendation",
      "Recruiter Decision",
      "Application Status",
      "Evaluated Date"
    ];
    const rows: Array<Array<string | number | Date | null>> = applications.map((app) => [
      job.jobCode,
      app.resume.resumeCode,
      app.candidate.fullName ?? "Not Available",
      app.candidate.mobileNumber ?? "Not Available",
      app.candidate.email ?? "Not Available",
      app.evaluation?.matchScore ?? null,
      (app.evaluation?.matchedSkills as string[] | null)?.join("; ") ?? "",
      (app.evaluation?.missingSkills as string[] | null)?.join("; ") ?? "",
      app.aiRecommendation ?? "",
      app.recruiterDecision,
      app.applicationStatus,
      app.evaluation?.evaluatedAt ?? null
    ]);
    return { header, rows };
  }

  async exportCandidatesCsv(organizationId: string, jobId: string): Promise<string> {
    const { header, rows } = await this.exportRows(organizationId, jobId);
    const stringRows = rows.map((row) =>
      row.map((cell) => (cell instanceof Date ? cell.toISOString() : (cell?.toString() ?? "")))
    );
    return [header, ...stringRows].map((row) => row.map(csvEscape).join(",")).join("\n");
  }

  /** Phase 5's XLSX export — same rows as CSV, with real numeric/date cell types, and the same
   * formula-injection guard (a cell starting with =, +, -, or @ is a formula in Excel/Sheets; every
   * string cell here originates from candidate- or recruiter-supplied data, so every one is sanitized). */
  async exportCandidatesXlsx(organizationId: string, jobId: string): Promise<Buffer> {
    const XLSX = await import("xlsx");
    const { header, rows } = await this.exportRows(organizationId, jobId);
    const sanitizedRows = rows.map((row) =>
      row.map((cell) => (typeof cell === "string" ? sanitizeSpreadsheetCell(cell) : cell))
    );
    const sheet = XLSX.utils.aoa_to_sheet([header, ...sanitizedRows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Candidates");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  /** `includeContact` defaults to false (fail-safe) — see the identical note on listCandidates above.
   * Sprint 7.17 Phase 5 remaining-steps audit found this endpoint had been missed on the first masking
   * pass and was still returning raw mobileNumber/email to any recruitment.candidates.review holder. */
  async getApplication(organizationId: string, applicationId: string, includeContact = false) {
    const application = await this.prisma.recruitmentApplication.findFirst({
      where: { id: applicationId, organizationId },
      include: { candidate: true, resume: true, evaluation: true, job: true, reviewedBy: true }
    });
    if (!application) throw new NotFoundException("RECRUITMENT_APPLICATION_NOT_FOUND");
    if (includeContact) return application;
    return { ...application, candidate: { ...application.candidate, mobileNumber: null, email: null } };
  }

  async reviewApplication(organizationId: string, applicationId: string, userId: string, dto: ReviewApplicationDto) {
    await this.getApplication(organizationId, applicationId);
    return this.prisma.recruitmentApplication.update({
      where: { id: applicationId },
      data: {
        recruiterDecision: dto.recruiterDecision,
        overrideReason: dto.overrideReason ?? null,
        reviewedByUserId: userId,
        reviewedAt: new Date()
      }
    });
  }

  async resumeDownloadUrl(organizationId: string, resumeId: string): Promise<string> {
    const resume = await this.prisma.recruitmentResume.findFirst({ where: { id: resumeId, organizationId } });
    if (!resume) throw new NotFoundException("RECRUITMENT_RESUME_NOT_FOUND");
    if (!this.objectStorage) throw new NotFoundException("RECRUITMENT_RESUME_STORAGE_UNAVAILABLE");
    return this.objectStorage.getSignedDownloadUrl(organizationId, resume.storageKey, 300);
  }

  private async nextResumeCode(organizationId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const count = await this.prisma.recruitmentResume.count({ where: { organizationId } });
    return `RES-${year}-${String(count + 1).padStart(5, "0")}`;
  }
}

/** Prefixes a cell that would otherwise be read as a formula (=, +, -, @ as the first character — the
 * classic CSV/XLSX injection vector, since candidate/job data is attacker-controllable free text) with a
 * tab character: invisible in a spreadsheet viewer, but stops Excel/Sheets/LibreOffice from evaluating
 * the cell as a formula. Applied to every exported string cell in both CSV and XLSX. */
export function sanitizeSpreadsheetCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `\t${value}` : value;
}

export function csvEscape(rawValue: string): string {
  const value = sanitizeSpreadsheetCell(rawValue);
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Magic-byte check for the two accepted document families — a declared Content-Type header is pure
 * client input and proves nothing about what the bytes actually are. PDF: "%PDF-". DOCX: a ZIP local-file
 * header (DOCX is a zipped XML package). Legacy .doc (application/msword): an OLE2 compound-file header. */
function hasValidFileSignature(mimeType: string, buffer: Buffer): boolean {
  if (mimeType === "application/pdf") {
    return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  }
  if (mimeType === "application/msword") {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0 &&
      buffer[4] === 0xa1 &&
      buffer[5] === 0xb1 &&
      buffer[6] === 0x1a &&
      buffer[7] === 0xe1
    );
  }
  return false;
}
