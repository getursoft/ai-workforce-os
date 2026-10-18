import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { OBJECT_STORAGE, type ObjectStorageService } from "../storage/object-storage.types";
import { RecruitmentParsingService } from "./recruitment-parsing.service";
import { RecruitmentScoringService, SCORING_VERSION } from "./recruitment-scoring.service";
import { normalizeLocation } from "./recruitment-location-taxonomy";

const CONFIDENCE_SCORE: Record<string, number> = { HIGH: 0.9, MEDIUM: 0.6, LOW: 0.3 };

/**
 * The durable, out-of-request worker behind bulk resume processing (Phase 3's "all uploads must be
 * processed asynchronously ... do not process 100 resumes synchronously inside a single HTTP request").
 * Mirrors apps/api/src/workforce/workforce-task-processor.ts exactly: no message broker/job queue exists
 * in this codebase, so a `setInterval` poll against durably-persisted QUEUED rows IS the queue. Two
 * independent phases per tick — resume text/field parsing, then per-application scoring — so a resume
 * matched against several jobs is parsed once but scored once per job (Phase 10).
 */
@Injectable()
export class RecruitmentBatchProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecruitmentBatchProcessor.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  static readonly POLL_INTERVAL_MS = 500;
  static readonly BATCH_SIZE = 5;
  /** A file that still fails after this many attempts stops retrying permanently (Phase 3's "maximum
   * retry counts") — e.g. a genuinely malformed document, or a provider outage that outlasts the job. */
  static readonly MAX_RETRIES = 3;
  /** A resume stuck in PROCESSING longer than this is assumed crashed mid-parse (the process died, not
   * just a slow provider call) and is recovered by the sweep below, never left stuck forever. */
  static readonly STUCK_PROCESSING_MS = 2 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly parsing: RecruitmentParsingService,
    private readonly scoring: RecruitmentScoringService,
    @Inject(OBJECT_STORAGE) @Optional() private readonly objectStorage?: ObjectStorageService
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), RecruitmentBatchProcessor.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed so a test (or an operator debugging a stuck batch) can force one pass without waiting on
   * the timer — same convention as WorkforceTaskProcessor.tick(). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.sweepStuckResumes();
      await this.parseQueuedResumes();
      await this.scorePendingApplications();
    } catch (error) {
      this.logger.error({ event: "RecruitmentBatchProcessorTickFailed", error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  /** Phase 5.3 — background worker suspension audit. Resumes/candidates are explicitly named as a
   * priority in that audit: this poller runs on its own setInterval tick with no HTTP request, no
   * JwtAccessGuard, and no per-user authorization context at all — only an organizationId on each row.
   * Candidates belonging to a suspended organization are filtered out BEFORE being claimed, so the
   * resume's retryCount/stuck-recovery budget is never spent on a suspension that's not the file's fault
   * — this is a deliberate DEFER, not a terminal fail: the row is left exactly as it was and is simply
   * picked up again on a later tick once the organization is reactivated, with zero data loss. */
  private async filterActiveOrganizations<T extends { organizationId: string }>(rows: T[]): Promise<T[]> {
    if (rows.length === 0) return rows;
    const orgIds = [...new Set(rows.map((row) => row.organizationId))];
    const active = await this.prisma.organization.findMany({
      where: { id: { in: orgIds }, status: "ACTIVE" },
      select: { id: true }
    });
    const activeIds = new Set(active.map((org) => org.id));
    return rows.filter((row) => activeIds.has(row.organizationId));
  }

  /** Recovers a resume the process crashed mid-parse on — still PROCESSING long after it should have
   * finished means the worker that claimed it is gone, not that the provider call is merely slow. Routed
   * through the same retry/give-up accounting as an ordinary parse failure. */
  private async sweepStuckResumes(): Promise<void> {
    const cutoff = new Date(Date.now() - RecruitmentBatchProcessor.STUCK_PROCESSING_MS);
    const stuck = await this.filterActiveOrganizations(
      await this.prisma.recruitmentResume.findMany({
        where: { parsingStatus: "PROCESSING", updatedAt: { lt: cutoff } },
        take: 25
      })
    );
    for (const resume of stuck) {
      await this.failOrRequeue(resume.id, resume.retryCount, "Processing did not complete — recovered after an apparent worker crash.");
    }
  }

  private async parseQueuedResumes(): Promise<void> {
    const candidates = await this.prisma.recruitmentResume.findMany({
      where: { parsingStatus: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: RecruitmentBatchProcessor.BATCH_SIZE * 3 // over-fetch; backoff filtering below may skip some
    });
    // Simple exponential backoff (2^retryCount seconds) computed here rather than in the query — Prisma
    // can't express a per-row dynamic "now - updatedAt >= f(retryCount)" comparison without raw SQL. A
    // fresh (retryCount 0) resume always qualifies immediately.
    const dueBeforeSuspensionFilter = candidates.filter((resume) => {
      if (resume.retryCount === 0) return true;
      const backoffMs = 2 ** resume.retryCount * 1000;
      return Date.now() - resume.updatedAt.getTime() >= backoffMs;
    });
    const due = (await this.filterActiveOrganizations(dueBeforeSuspensionFilter)).slice(
      0,
      RecruitmentBatchProcessor.BATCH_SIZE
    );
    for (const resume of due) {
      await this.parseOne(resume.id).catch((error) => {
        this.logger.error({ event: "RecruitmentResumeParseFailed", resumeId: resume.id, error: String(error) });
      });
    }
  }

  /** Shared give-up-or-try-again accounting for both an ordinary parse failure and a recovered stuck
   * (crashed) resume — caps total attempts at MAX_RETRIES rather than retrying a broken file forever. */
  private async failOrRequeue(resumeId: string, currentRetryCount: number, message: string): Promise<void> {
    const nextRetryCount = currentRetryCount + 1;
    const exhausted = nextRetryCount >= RecruitmentBatchProcessor.MAX_RETRIES;
    const resume = await this.prisma.recruitmentResume.update({
      where: { id: resumeId },
      data: {
        retryCount: nextRetryCount,
        parsingStatus: exhausted ? "FAILED" : "QUEUED",
        parsingError: exhausted ? `${message} (gave up after ${nextRetryCount} attempts)`.slice(0, 500) : message.slice(0, 500)
      }
    });
    if (exhausted) await this.bumpBatchCounters(resume.uploadBatchId, { failed: 1 });
  }

  private async parseOne(resumeId: string): Promise<void> {
    const claimed = await this.prisma.recruitmentResume.updateMany({
      where: { id: resumeId, parsingStatus: "QUEUED" },
      data: { parsingStatus: "PROCESSING" }
    });
    if (claimed.count === 0) return; // already claimed by a concurrent tick/process
    const resume = await this.prisma.recruitmentResume.findUniqueOrThrow({ where: { id: resumeId } });
    try {
      const recruitmentPluginId = await this.requireRecruitmentPluginId(resume.organizationId);
      // Re-extracts from a stored copy of the original bytes only if not already extracted — the file
      // bytes themselves aren't re-read here since object storage retrieval isn't needed for text already
      // captured at ingest time in a prior run; first-time extraction happens via the stored buffer path
      // below when `extractedText` is still empty.
      let extractedText = resume.extractedText;
      if (!extractedText) {
        const buffer = await this.readResumeBytes(resume.organizationId, resume.storageKey);
        const mimeType = resume.fileName.toLowerCase().endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf";
        extractedText = await this.parsing.extractText(mimeType, buffer);
      }
      const { fields, warnings } = await this.parsing.parseResume(
        resume.organizationId,
        recruitmentPluginId,
        extractedText
      );
      const candidateId = await this.resolveCandidate(resume.organizationId, fields);
      await this.prisma.recruitmentResume.update({
        where: { id: resumeId },
        data: {
          extractedText,
          parsedData: fields as unknown as object,
          parsingWarnings: warnings,
          parsingVersion: RecruitmentParsingService.PARSING_VERSION,
          parsingStatus: "COMPLETED",
          parsingError: null,
          candidateId,
          totalExperienceYears: fields.totalExperienceYears,
          relevantExperienceYears: fields.relevantExperienceYears,
          extractedSkills: fields.skills
        }
      });
      await this.bumpBatchCounters(resume.uploadBatchId, { completed: 1 });
    } catch (error) {
      // Only reached for a thrown exception — e.g. extraction failing on genuinely malformed bytes, or
      // the recruitment consultant not being installed. An LLM provider failure alone does NOT land here:
      // RecruitmentParsingService.parseResume() already catches that internally and degrades gracefully
      // (empty fields + a warning, still COMPLETED) rather than throwing, so a provider outage never
      // exhausts these retries by itself.
      await this.failOrRequeue(
        resumeId,
        resume.retryCount,
        (error instanceof Error ? error.message : "Parsing failed")
      );
    }
  }

  /** Matches an existing candidate by email or phone within the organization (Phase 10's "do not
   * unnecessarily create duplicate candidate records"); otherwise fills in the placeholder candidate row
   * created at upload time. Never merges across organizations. */
  private async resolveCandidate(
    organizationId: string,
    fields: Awaited<ReturnType<RecruitmentParsingService["parseResume"]>>["fields"]
  ): Promise<string | null> {
    const existing = await this.prisma.recruitmentCandidate.findFirst({
      where: {
        organizationId,
        OR: [
          ...(fields.email ? [{ email: fields.email }] : []),
          ...(fields.phone ? [{ mobileNumber: fields.phone }] : [])
        ]
      }
    });
    const normalized = normalizeLocation(fields.currentCity, fields.currentState);
    // Phase 5: "Do not overwrite human-corrected candidate information" — a prior human edit (recorded via
    // locationSource = "HUMAN_CORRECTED") permanently opts a candidate out of automatic overwrite, even on
    // a later re-parse of a newer/different resume for the same person. Always writes every key (never a
    // conditionally-omitted one) so the update payload has one stable shape under exactOptionalPropertyTypes.
    const humanCorrected = existing?.locationSource === "HUMAN_CORRECTED";
    const locationData = humanCorrected
      ? {
          currentCity: existing.currentCity,
          currentState: existing.currentState,
          currentCountry: existing.currentCountry,
          normalizedRegion: existing.normalizedRegion,
          preferredWorkLocations: existing.preferredWorkLocations,
          willingToRelocate: existing.willingToRelocate,
          workModePreference: existing.workModePreference,
          noticePeriod: existing.noticePeriod,
          locationExtractionConfidence: existing.locationExtractionConfidence,
          locationSource: existing.locationSource,
          locationExtractionVersion: existing.locationExtractionVersion,
          locationExtractedAt: existing.locationExtractedAt
        }
      : {
          currentCity: fields.currentCity,
          currentState: fields.currentState,
          currentCountry: fields.currentCountry,
          normalizedRegion: normalized.normalizedRegion,
          preferredWorkLocations: fields.preferredWorkLocations,
          willingToRelocate: fields.willingToRelocate,
          workModePreference: fields.workModePreference,
          noticePeriod: fields.noticePeriod,
          locationExtractionConfidence: fields.locationConfidence
            ? (CONFIDENCE_SCORE[fields.locationConfidence] ?? null)
            : null,
          locationSource: "RESUME_TEXT",
          locationExtractionVersion: RecruitmentParsingService.PARSING_VERSION,
          locationExtractedAt: new Date() as Date | null
        };
    if (existing) {
      await this.prisma.recruitmentCandidate.update({
        where: { id: existing.id },
        data: {
          fullName: existing.fullName ?? fields.name,
          email: existing.email ?? fields.email,
          mobileNumber: existing.mobileNumber ?? fields.phone,
          ...locationData
        }
      });
      return existing.id;
    }
    const candidate = await this.prisma.recruitmentCandidate.create({
      data: {
        organizationId,
        fullName: fields.name,
        email: fields.email,
        mobileNumber: fields.phone,
        ...locationData
      }
    });
    return candidate.id;
  }

  private async scorePendingApplications(): Promise<void> {
    const candidates = await this.prisma.recruitmentApplication.findMany({
      where: {
        resume: { parsingStatus: "COMPLETED" },
        OR: [{ evaluation: null }, { evaluation: { evaluationStatus: "PENDING" } }]
      },
      orderBy: { createdAt: "asc" },
      take: RecruitmentBatchProcessor.BATCH_SIZE * 3,
      include: { resume: true, job: true }
    });
    const due = (await this.filterActiveOrganizations(candidates)).slice(0, RecruitmentBatchProcessor.BATCH_SIZE);
    for (const application of due) {
      await this.scoreOne(application.id).catch((error) => {
        this.logger.error({ event: "RecruitmentApplicationScoreFailed", applicationId: application.id, error: String(error) });
      });
    }
  }

  private async scoreOne(applicationId: string): Promise<void> {
    const application = await this.prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { resume: true, job: true }
    });
    try {
      const recruitmentPluginId = await this.requireRecruitmentPluginId(application.organizationId);
      const fields = (application.resume.parsedData ?? {}) as unknown as Awaited<
        ReturnType<RecruitmentParsingService["parseResume"]>
      >["fields"];
      const criteria = application.job.requiredCriteria as unknown as {
        mandatorySkills: string[];
        preferredSkills?: string[];
        certifications?: string[];
        educationRequirements?: string[];
        domainKnowledge?: string[];
      };
      const weights = application.job.scoringConfig as unknown as {
        mandatorySkillWeight: number;
        preferredSkillWeight: number;
        experienceWeight: number;
        projectExperienceWeight: number;
        certificationWeight: number;
      };
      const result = await this.scoring.score(
        application.organizationId,
        recruitmentPluginId,
        {
          mandatorySkills: criteria.mandatorySkills ?? [],
          preferredSkills: criteria.preferredSkills ?? [],
          certifications: criteria.certifications ?? [],
          educationRequirements: criteria.educationRequirements ?? [],
          domainKnowledge: criteria.domainKnowledge ?? []
        },
        weights,
        application.job.minExperienceYears,
        application.resume.extractedText ?? "",
        fields
      );
      // >= threshold -> recommended; Phase 6's exact-boundary requirement (80.00 recommended, 79.99 not).
      const aiRecommendation =
        result.matchScore >= application.job.recommendationThreshold
          ? "RECOMMENDED_FOR_SHORTLIST"
          : "BELOW_MATCH_THRESHOLD";
      await this.prisma.$transaction([
        this.prisma.recruitmentEvaluation.upsert({
          where: { applicationId },
          create: {
            applicationId,
            matchScore: result.matchScore,
            scoreBreakdown: result.scoreBreakdown as unknown as object,
            matchedSkills: result.matchedSkills,
            missingSkills: result.missingSkills,
            evidence: result.evidence as unknown as object,
            explanation: result.explanation,
            warnings: result.warnings,
            scoringVersion: SCORING_VERSION,
            evaluationStatus: "COMPLETED",
            evaluatedAt: new Date()
          },
          update: {
            matchScore: result.matchScore,
            scoreBreakdown: result.scoreBreakdown as unknown as object,
            matchedSkills: result.matchedSkills,
            missingSkills: result.missingSkills,
            evidence: result.evidence as unknown as object,
            explanation: result.explanation,
            warnings: result.warnings,
            scoringVersion: SCORING_VERSION,
            evaluationStatus: "COMPLETED",
            evaluatedAt: new Date()
          }
        }),
        this.prisma.recruitmentApplication.update({ where: { id: applicationId }, data: { aiRecommendation } })
      ]);
    } catch (error) {
      await this.prisma.recruitmentEvaluation.upsert({
        where: { applicationId },
        create: {
          applicationId,
          scoringVersion: SCORING_VERSION,
          evaluationStatus: "FAILED",
          evaluationError: (error instanceof Error ? error.message : "Scoring failed").slice(0, 500)
        },
        update: {
          evaluationStatus: "FAILED",
          evaluationError: (error instanceof Error ? error.message : "Scoring failed").slice(0, 500)
        }
      });
      // Incomplete analysis -> REVIEW_REQUIRED, never silently left blank or treated as a pass/fail.
      await this.prisma.recruitmentApplication.update({
        where: { id: applicationId },
        data: { aiRecommendation: "REVIEW_REQUIRED" }
      });
    }
  }

  private async requireRecruitmentPluginId(organizationId: string): Promise<string> {
    const plugin = await this.prisma.plugin.findFirst({
      where: { organizationId, slug: "recruitment-consultant", deletedAt: null }
    });
    if (!plugin) throw new Error("RECRUITMENT_CONSULTANT_NOT_INSTALLED");
    return plugin.id;
  }

  private async readResumeBytes(organizationId: string, storageKey: string): Promise<Buffer> {
    if (!this.objectStorage) throw new Error("RECRUITMENT_OBJECT_STORAGE_UNAVAILABLE");
    return this.objectStorage.getObject(organizationId, storageKey);
  }

  private async bumpBatchCounters(
    uploadBatchId: string | null,
    delta: { completed?: number; failed?: number }
  ): Promise<void> {
    if (!uploadBatchId) return;
    const batch = await this.prisma.recruitmentUploadBatch.findUnique({ where: { id: uploadBatchId } });
    if (!batch) return;
    const completedFiles = batch.completedFiles + (delta.completed ?? 0);
    const failedFiles = batch.failedFiles + (delta.failed ?? 0);
    const done = completedFiles + failedFiles >= batch.totalFiles;
    await this.prisma.recruitmentUploadBatch.update({
      where: { id: uploadBatchId },
      data: {
        completedFiles,
        failedFiles,
        queuedFiles: Math.max(0, batch.totalFiles - completedFiles - failedFiles),
        status: done ? (failedFiles > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED") : "PROCESSING",
        ...(done ? { completedAt: new Date() } : {})
      }
    });
  }
}
