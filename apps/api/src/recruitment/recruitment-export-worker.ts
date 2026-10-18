/**
 * Sprint 7.17 (Phase 3) — drains RecruitmentExportJob rows that RecruitmentExportService marked QUEUED
 * because they exceeded SYNCHRONOUS_ROW_CAP. Registered against the SAME PostgresQueueAdapter every other
 * background job in this codebase uses (QueueConsumerWorker claims it, this handler just processes one
 * message) — not a second, bespoke polling loop.
 *
 * Bounded memory at any scale: rows are fetched EXPORT_PAGE_SIZE at a time via the shared cursor-paginated
 * RecruitmentCandidateQueryService (never one unbounded query for the whole export), and written
 * incrementally to a local temp file rather than built up as an in-memory object graph — for CSV via a
 * plain write stream, for XLSX via exceljs's true streaming WorkbookWriter (SheetJS, used by the
 * synchronous small-export path, always holds the entire sheet as an in-memory AOA/cell-object graph,
 * which is exactly the "pagination alone is not memory-safe for XLSX" risk the sprint spec calls out).
 * Only the final temp file is read back into memory once, to hand to ObjectStorageService.putObject
 * (which has no streaming-upload variant) — its size is bounded by the export's row/column count, not by
 * any multiplicative in-memory formatting overhead.
 */

import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";
import { QueueHandlerRegistry } from "../queue/queue-worker";
import type { QueueMessageView } from "../queue/queue.types";
import { RecruitmentCandidateQueryService, type RecruitmentCandidateQuery } from "./recruitment-candidate-query.service";
import {
  EXPORT_FIELDS,
  EXPORT_PAGE_SIZE,
  buildExportRow,
  exportFieldHeaders,
  type ExportField,
  type RequestExportInput
} from "./recruitment-export.service";
import { csvEscape, sanitizeSpreadsheetCell } from "./recruitment-resume.service";

const EXPORT_EXPIRY_HOURS = 24;
/** Date-typed filter fields get flattened to ISO strings by Prisma's Json column round-trip; these are
 * the only ones RecruitmentCandidateQuery declares as Date, so they're the only ones that need reviving
 * before the stored filters are fed back into the query service. */
const FILTER_DATE_FIELDS = ["uploadDateFrom", "uploadDateTo", "evaluationDateFrom", "evaluationDateTo"] as const;

function reviveFilterDates(raw: unknown): RecruitmentCandidateQuery | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const revived: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const field of FILTER_DATE_FIELDS) {
    if (typeof revived[field] === "string") revived[field] = new Date(revived[field] as string);
  }
  return revived as RecruitmentCandidateQuery;
}

@Injectable()
export class RecruitmentExportWorkerService implements OnModuleInit {
  private readonly logger = new Logger(RecruitmentExportWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: RecruitmentCandidateQueryService,
    private readonly registry: QueueHandlerRegistry,
    private readonly authorization: AuthorizationService,
    @Inject(OBJECT_STORAGE) @Optional() private readonly objectStorage?: ObjectStorageService
  ) {}

  onModuleInit(): void {
    this.registry.register("RECRUITMENT_EXPORTS" as Parameters<QueueHandlerRegistry["register"]>[0], this.handle.bind(this));
  }

  async handle(message: QueueMessageView): Promise<boolean> {
    const job = await this.prisma.recruitmentExportJob.findFirst({
      where: { id: message.refId, organizationId: message.organizationId }
    });
    if (!job) {
      this.logger.warn({ event: "RECRUITMENT_EXPORT_JOB_MISSING", exportJobId: message.refId });
      return true; // nothing to retry — the business row is gone (e.g. a test cleaned it up)
    }
    // Idempotent no-op: a prior attempt may have already finished (or the requester cancelled) between
    // this message being claimed and the handler actually running.
    if (job.status === "COMPLETED" || job.status === "CANCELLED" || job.status === "EXPIRED") return true;

    // Sprint 7.17 — export permission revocation fix. A job sits QUEUED behind other work, or gets
    // retried after a transient failure, on a timeline fully decoupled from the HTTP request that
    // originally passed PermissionGuard. Re-verify the requester's CURRENT org membership and export
    // permission every time this handler runs (first attempt and every retry alike) — never trust that
    // authorization granted at enqueue time still holds. If the lookup itself can't be completed safely,
    // fail closed: no file is produced either way.
    let authorized: boolean;
    try {
      authorized = await this.isRequesterAuthorized(job.organizationId, job.requestedByUserId);
    } catch (error) {
      this.logger.error({
        event: "RECRUITMENT_EXPORT_AUTH_CHECK_FAILED",
        exportJobId: job.id,
        error: error instanceof Error ? error.message : "unknown"
      });
      await this.prisma.recruitmentExportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorMessage: "RECRUITMENT_EXPORT_AUTH_CHECK_FAILED" }
      });
      return true; // Not retried: an authorization state we can't safely read is treated as denied, not transient.
    }
    if (!authorized) {
      this.logger.warn({ event: "RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED", exportJobId: job.id, requestedByUserId: job.requestedByUserId });
      await this.prisma.recruitmentExportJob.update({
        where: { id: job.id },
        data: { status: "CANCELLED", errorMessage: "RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED" }
      });
      return true;
    }

    await this.prisma.recruitmentExportJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });

    const revivedFilters = reviveFilterDates(job.filters);
    const fieldSelection = job.fieldSelection as ExportField[] | null;
    const selectedApplicationIds = job.selectedIds as string[] | null;
    const input: RequestExportInput = {
      scope: job.scope,
      format: job.format,
      ...(job.jobId ? { jobId: job.jobId } : {}),
      ...(revivedFilters ? { filters: revivedFilters } : {}),
      ...(fieldSelection ? { fieldSelection } : {}),
      ...(selectedApplicationIds ? { selectedApplicationIds } : {})
    };
    const fields = input.fieldSelection?.length ? input.fieldSelection : EXPORT_FIELDS;
    const isLastAttempt = message.attemptCount >= message.maxAttempts;

    let tempDir: string | null = null;
    try {
      if (!this.objectStorage) throw new Error("RECRUITMENT_OBJECT_STORAGE_UNAVAILABLE");
      tempDir = await mkdtemp(join(tmpdir(), "recruitment-export-"));
      const extension = input.format === "XLSX" ? "xlsx" : "csv";
      const filePath = join(tempDir, `export.${extension}`);

      const { rowCount, haltReason } =
        input.format === "XLSX"
          ? await this.writeXlsx(job.organizationId, job.id, job.requestedByUserId, input, fields, filePath)
          : await this.writeCsv(job.organizationId, job.id, job.requestedByUserId, input, fields, filePath);

      if (haltReason === "CANCELLED") {
        this.logger.log({ event: "RECRUITMENT_EXPORT_CANCELLED_MID_GENERATION", exportJobId: job.id, rowCount });
        return true; // status is already CANCELLED (set by cancelExport); nothing more to do, no file is uploaded
      }
      if (haltReason === "REVOKED") {
        // Phase 5.1: the requester's authorization was pulled WHILE this attempt was already mid-page-loop,
        // not just between attempts/retries. The per-page check below caught it before the next page of
        // candidate data was fetched; no file is ever uploaded for a halted run.
        this.logger.warn({ event: "RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED_MID_EXPORT", exportJobId: job.id, rowCount });
        await this.prisma.recruitmentExportJob.update({
          where: { id: job.id },
          data: { status: "CANCELLED", errorMessage: "RECRUITMENT_EXPORT_AUTHORIZATION_REVOKED_MID_EXPORT" }
        });
        return true;
      }

      const buffer = await readFile(filePath);
      const downloadToken = randomBytes(24).toString("base64url");
      const contentType =
        input.format === "XLSX"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv";
      const storageKey = `recruitment/exports/${job.id}.${extension}`;
      await this.objectStorage.putObject({ organizationId: job.organizationId, key: storageKey, buffer, contentType });

      const expiresAt = new Date(Date.now() + EXPORT_EXPIRY_HOURS * 60 * 60 * 1000);
      await this.prisma.recruitmentExportJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED", rowCount, storageKey, downloadToken, expiresAt, completedAt: new Date() }
      });
      this.logger.log({ event: "RECRUITMENT_EXPORT_COMPLETED", exportJobId: job.id, rowCount, format: input.format });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Export generation failed";
      this.logger.error({
        event: "RECRUITMENT_EXPORT_WORKER_FAILED",
        exportJobId: job.id,
        attempt: message.attemptCount,
        maxAttempts: message.maxAttempts,
        error: errorMessage
      });
      if (isLastAttempt) {
        await this.prisma.recruitmentExportJob.update({
          where: { id: job.id },
          data: { status: "FAILED", errorMessage: errorMessage.slice(0, 500) }
        });
      }
      // Returning false (rather than rethrowing) hands control back to QueueConsumerWorker's existing
      // fail() path — same exponential-backoff retry ladder and dead-lettering every other job type gets.
      return false;
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  /** The requester must still be an active member of the job's organization AND still hold
   * recruitment.candidates.export right now — both independently re-derived from the database (not the
   * JWT the original HTTP request carried, which this background handler never sees). */
  private async isRequesterAuthorized(organizationId: string, requestedByUserId: string): Promise<boolean> {
    const [stillMember, stillExportAuthorized] = await Promise.all([
      this.authorization.canAccessOrganization(requestedByUserId, organizationId),
      this.authorization.hasPermission(requestedByUserId, organizationId, "recruitment.candidates.export")
    ]);
    return stillMember && stillExportAuthorized;
  }

  /** Cooperative halt check: run once per page (bounded latency — never mid-page), not via any separate
   * polling mechanism. Covers two independent reasons to stop: an explicit user cancellation (job.status
   * already flipped to CANCELLED by cancelExport) and a mid-export authorization revocation (the
   * requester's org membership or recruitment.candidates.export permission disappearing while THIS
   * attempt is still running — the gap Phase 5.1 closes; the top-of-handle() check only ever caught this
   * between attempts, never during one already in progress). Either reason stops the loop before the
   * next page of candidate data — including contact fields — is ever fetched. */
  private async checkMidExportHalt(
    organizationId: string,
    exportJobId: string,
    requestedByUserId: string
  ): Promise<"CANCELLED" | "REVOKED" | null> {
    const row = await this.prisma.recruitmentExportJob.findFirst({
      where: { id: exportJobId, organizationId },
      select: { status: true }
    });
    if (row?.status === "CANCELLED") return "CANCELLED";
    if (!(await this.isRequesterAuthorized(organizationId, requestedByUserId))) return "REVOKED";
    return null;
  }

  /** Yields successive pages of applications for the export's scope, each page bounded to
   * EXPORT_PAGE_SIZE rows — the only thing ever held in memory from the DB side at once. */
  private async *pages(
    organizationId: string,
    input: RequestExportInput
  ): AsyncGenerator<Awaited<ReturnType<RecruitmentCandidateQueryService["query"]>>["items"]> {
    if (input.scope === "SELECTED") {
      const ids = input.selectedApplicationIds ?? [];
      for (let i = 0; i < ids.length; i += EXPORT_PAGE_SIZE) {
        const chunk = ids.slice(i, i + EXPORT_PAGE_SIZE);
        yield this.prisma.recruitmentApplication.findMany({
          where: { organizationId, id: { in: chunk } },
          include: { candidate: true, resume: true, evaluation: true, job: true }
        });
      }
      return;
    }
    let cursor: string | undefined;
    const baseQuery: RecruitmentCandidateQuery = {
      ...(input.filters ?? {}),
      ...(input.scope === "CURRENT_JOB" && input.jobId ? { jobId: input.jobId } : {}),
      limit: EXPORT_PAGE_SIZE
    };
    do {
      // includeContact: true — see the identical note in RecruitmentExportService.resolveApplications.
      const result = await this.queries.query(organizationId, { ...baseQuery, ...(cursor ? { cursor } : {}) }, { includeContact: true });
      yield result.items;
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
  }

  private async writeCsv(
    organizationId: string,
    exportJobId: string,
    requestedByUserId: string,
    input: RequestExportInput,
    fields: readonly ExportField[],
    filePath: string
  ): Promise<{ rowCount: number; haltReason: "CANCELLED" | "REVOKED" | null }> {
    const stream = createWriteStream(filePath, { encoding: "utf8" });
    const write = (line: string) =>
      new Promise<void>((resolve, reject) => {
        if (stream.write(line)) resolve();
        else stream.once("drain", resolve);
        stream.once("error", reject);
      });

    let rowCount = 0;
    let haltReason: "CANCELLED" | "REVOKED" | null = null;
    try {
      await write(exportFieldHeaders(fields).map(csvEscape).join(",") + "\n");
      // Checked BEFORE each page is fetched, not after — a revoked requester never has even one more
      // page's worth of candidate contact data pulled into memory, let alone written to the file.
      const pages = this.pages(organizationId, input);
      while (true) {
        haltReason = await this.checkMidExportHalt(organizationId, exportJobId, requestedByUserId);
        if (haltReason) break;
        const next = await pages.next();
        if (next.done) break;
        for (const app of next.value) {
          const row = buildExportRow(app, fields).map((cell) =>
            cell instanceof Date ? cell.toISOString() : (cell?.toString() ?? "")
          );
          await write(row.map(csvEscape).join(",") + "\n");
          rowCount += 1;
        }
      }
    } finally {
      await new Promise<void>((resolve) => stream.end(resolve));
    }
    return { rowCount, haltReason };
  }

  private async writeXlsx(
    organizationId: string,
    exportJobId: string,
    requestedByUserId: string,
    input: RequestExportInput,
    fields: readonly ExportField[],
    filePath: string
  ): Promise<{ rowCount: number; haltReason: "CANCELLED" | "REVOKED" | null }> {
    // useStyles/useSharedStrings both false: this is the lowest-memory streaming mode exceljs offers,
    // appropriate for a flat data export with no formatting needs.
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: false, useSharedStrings: false });
    const worksheet = workbook.addWorksheet("Candidates");
    // exceljs's streaming Row/Worksheet .commit() isn't reflected in its published .d.ts (a known gap in
    // the library's own types, not a workaround for ours) — hence the casts below.
    (worksheet.addRow(exportFieldHeaders(fields)) as unknown as { commit(): void }).commit();

    let rowCount = 0;
    let haltReason: "CANCELLED" | "REVOKED" | null = null;
    // Checked BEFORE each page is fetched — see the identical note in writeCsv above.
    const pages = this.pages(organizationId, input);
    while (true) {
      haltReason = await this.checkMidExportHalt(organizationId, exportJobId, requestedByUserId);
      if (haltReason) break;
      const next = await pages.next();
      if (next.done) break;
      for (const app of next.value) {
        const row = buildExportRow(app, fields).map((cell) => (typeof cell === "string" ? sanitizeSpreadsheetCell(cell) : cell));
        (worksheet.addRow(row) as unknown as { commit(): void }).commit();
        rowCount += 1;
      }
    }
    // A halted run still commits whatever the streaming writer has already buffered to the temp file on
    // disk — but handle() never reads that file into a buffer or calls putObject when haltReason is set,
    // so this never becomes a downloadable artifact; it is deleted by handle()'s own finally block.
    (worksheet as unknown as { commit(): void }).commit();
    await workbook.commit();
    return { rowCount, haltReason };
  }
}
