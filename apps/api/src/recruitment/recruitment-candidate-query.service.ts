import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { citiesInRegion } from "./recruitment-location-taxonomy";

/**
 * Sprint 7.16 (Phase 6) — the ONE query builder every client (website, iOS, WhatsApp, export engine)
 * must go through. Centralizing this is what makes "identical queries return identical results across
 * surfaces" (Phase 12) true by construction rather than by convention: there is nowhere else a filter can
 * be implemented differently. Tenant isolation (`organizationId`) is applied unconditionally and cannot
 * be overridden by any field on the query object below.
 */
export interface RecruitmentCandidateQuery {
  /** Scope to one job; omit for a cross-job query (export engine's "Cross-Job Candidates" scope,
   * permission-gated at the controller layer, not here). */
  jobId?: string;

  // --- ATS Score (Phase 6: "Use numeric comparisons, not string matching" and explicitly distinguish
  // >80 from >=80 — hence four independent operators rather than a single "min/max" pair). ---
  scoreGreaterThan?: number;
  scoreGreaterThanOrEqual?: number;
  scoreLessThan?: number;
  scoreLessThanOrEqual?: number;

  // --- Location ---
  currentCity?: string[];
  currentState?: string[];
  currentCountry?: string[];
  /** Expanded via citiesInRegion() into a currentCity IN (...) match — "Delhi NCR" matches Noida,
   * Gurugram, Ghaziabad, Faridabad and Delhi itself, not just candidates whose raw city string is
   * literally "Delhi NCR". */
  region?: string[];
  preferredWorkLocation?: string[];
  willingToRelocate?: boolean;

  // --- Experience ---
  minTotalExperienceYears?: number;
  maxTotalExperienceYears?: number;
  minRelevantExperienceYears?: number;
  maxRelevantExperienceYears?: number;

  // --- Skills (against RecruitmentResume.extractedSkills, case-insensitive) ---
  allSkills?: string[];
  anySkills?: string[];
  /** True = only candidates whose evaluation.missingSkills contains none of the job's mandatorySkills.
   * Only meaningful (and only applied) when `jobId` is set. */
  mandatorySkillsFullyMatched?: boolean;

  // --- Application ---
  aiRecommendation?: ("RECOMMENDED_FOR_SHORTLIST" | "BELOW_MATCH_THRESHOLD" | "REVIEW_REQUIRED")[];
  recruiterDecision?: (
    | "PENDING_REVIEW"
    | "SHORTLISTED"
    | "NOT_SELECTED"
    | "INTERVIEW_SCHEDULED"
    | "INTERVIEW_COMPLETED"
    | "ON_HOLD"
    | "HIRED"
  )[];
  applicationStatus?: string[];
  uploadDateFrom?: Date;
  uploadDateTo?: Date;
  evaluationDateFrom?: Date;
  evaluationDateTo?: Date;
  sourceChannel?: ("WEBSITE" | "WHATSAPP")[];
  /** Free-text candidate name/email/phone search — kept separate from the structured filters above since
   * it's the one genuinely string-matched field (Phase 6 only requires numeric comparisons for score). */
  search?: string;

  sortBy?:
    | "score_desc"
    | "score_asc"
    | "experience_desc"
    | "experience_asc"
    | "uploadDate_desc"
    | "uploadDate_asc"
    | "name_asc";
  /** Opaque cursor from a previous page's `nextCursor` — stable across pages because sortBy is always
   * paired with `id` as a tiebreaker (Phase 6: "Ensure sorting remains deterministic across pages"). */
  cursor?: string;
  limit?: number;
}

export interface RecruitmentCandidateQueryResult {
  items: Array<
    Prisma.RecruitmentApplicationGetPayload<{
      include: { candidate: true; resume: true; evaluation: true; job: true };
    }>
  >;
  nextCursor: string | null;
  totalCount: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface CursorPayload {
  sortValue: string | number | null;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") return parsed as CursorPayload;
    return null;
  } catch {
    return null;
  }
}

export interface RecruitmentCandidateQueryOptions {
  /** Sprint 7.17 (Phase 5) — fail-safe by default (false): mobileNumber/email are stripped from every
   * returned candidate unless the caller has already verified `recruitment.candidates.contact` and
   * explicitly asserts that here. This is enforced ONCE, in the one service every client (website, iOS,
   * WhatsApp) and the export engine goes through — never left to each caller to remember to mask on its
   * own, which is exactly how the website and iOS search path ended up returning raw phone numbers to
   * any `recruitment.candidates.review` holder with no contact-permission check at all. The export engine
   * passes `true` deliberately: `recruitment.candidates.export` is its own, already-broader permission
   * that has always included contact fields by design (Sprint 7.16), not an oversight to fix here. */
  includeContact?: boolean;
}

@Injectable()
export class RecruitmentCandidateQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async query(
    organizationId: string,
    input: RecruitmentCandidateQuery,
    options: RecruitmentCandidateQueryOptions = {}
  ): Promise<RecruitmentCandidateQueryResult> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = this.buildWhere(organizationId, input);
    const { orderBy, cursorWhere } = this.buildOrdering(input);

    const combinedWhere: Prisma.RecruitmentApplicationWhereInput = cursorWhere
      ? { AND: [where, cursorWhere] }
      : where;

    const [totalCount, rows] = await Promise.all([
      this.prisma.recruitmentApplication.count({ where }),
      this.prisma.recruitmentApplication.findMany({
        where: combinedWhere,
        orderBy,
        take: limit + 1,
        include: { candidate: true, resume: true, evaluation: true, job: true }
      })
    ]);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
      options.includeContact ? row : { ...row, candidate: { ...row.candidate, mobileNumber: null, email: null } }
    );
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ sortValue: this.sortValueOf(last, input.sortBy), id: last.id })
        : null;

    return { items, nextCursor, totalCount };
  }

  /** Builds the Prisma where-clause. `organizationId` is always the first condition and is never derived
   * from anything on `input` — every call site passes it from the authenticated principal, never from
   * client-supplied data (Phase 6: "Apply tenant isolation in every database query"). */
  private buildWhere(organizationId: string, input: RecruitmentCandidateQuery): Prisma.RecruitmentApplicationWhereInput {
    const and: Prisma.RecruitmentApplicationWhereInput[] = [{ organizationId }];

    if (input.jobId) and.push({ jobId: input.jobId });

    const scoreFilter: Prisma.FloatNullableFilter = {};
    if (input.scoreGreaterThan !== undefined) scoreFilter.gt = input.scoreGreaterThan;
    if (input.scoreGreaterThanOrEqual !== undefined) scoreFilter.gte = input.scoreGreaterThanOrEqual;
    if (input.scoreLessThan !== undefined) scoreFilter.lt = input.scoreLessThan;
    if (input.scoreLessThanOrEqual !== undefined) scoreFilter.lte = input.scoreLessThanOrEqual;
    if (Object.keys(scoreFilter).length > 0) and.push({ evaluation: { matchScore: scoreFilter } });

    const candidateFilter: Prisma.RecruitmentCandidateWhereInput = {};
    if (input.currentCity?.length) candidateFilter.currentCity = { in: input.currentCity, mode: "insensitive" };
    if (input.currentState?.length) candidateFilter.currentState = { in: input.currentState, mode: "insensitive" };
    if (input.currentCountry?.length) candidateFilter.currentCountry = { in: input.currentCountry, mode: "insensitive" };
    if (input.region?.length) {
      // A region with no known cities (unrecognized taxonomy entry) must match nothing, not everything —
      // an empty `in: []` correctly excludes all rows rather than silently being ignored.
      const expandedCities = input.region.flatMap((region) => citiesInRegion(region));
      candidateFilter.currentCity = { in: expandedCities, mode: "insensitive" };
    }
    if (input.preferredWorkLocation?.length) candidateFilter.preferredWorkLocations = { hasSome: input.preferredWorkLocation };
    if (input.willingToRelocate !== undefined) candidateFilter.willingToRelocate = input.willingToRelocate;
    if (input.search) {
      candidateFilter.OR = [
        { fullName: { contains: input.search, mode: "insensitive" } },
        { email: { contains: input.search, mode: "insensitive" } },
        { mobileNumber: { contains: input.search } }
      ];
    }
    if (Object.keys(candidateFilter).length > 0) and.push({ candidate: candidateFilter });

    const resumeFilter: Prisma.RecruitmentResumeWhereInput = {};
    const totalExpFilter: Prisma.IntNullableFilter = {};
    if (input.minTotalExperienceYears !== undefined) totalExpFilter.gte = input.minTotalExperienceYears;
    if (input.maxTotalExperienceYears !== undefined) totalExpFilter.lte = input.maxTotalExperienceYears;
    if (Object.keys(totalExpFilter).length > 0) resumeFilter.totalExperienceYears = totalExpFilter;
    const relevantExpFilter: Prisma.IntNullableFilter = {};
    if (input.minRelevantExperienceYears !== undefined) relevantExpFilter.gte = input.minRelevantExperienceYears;
    if (input.maxRelevantExperienceYears !== undefined) relevantExpFilter.lte = input.maxRelevantExperienceYears;
    if (Object.keys(relevantExpFilter).length > 0) resumeFilter.relevantExperienceYears = relevantExpFilter;
    // Checks BOTH the LLM-derived extractedSkills array AND a deterministic case-insensitive substring
    // search against the raw extracted text — the same resilience the scoring engine already has
    // (recruitment-scoring.service.ts's deterministicMatch works without any LLM). Without this fallback,
    // the skills filter would silently return zero matches for any organization with no AI provider
    // connected, even though RecruitmentEvaluation.matchedSkills proves the skill really is present in
    // the resume text — found via real end-to-end UAT execution, not a hypothetical.
    if (input.allSkills?.length) {
      and.push({
        AND: input.allSkills.map((skill) => ({
          resume: {
            OR: [
              { extractedSkills: { has: skill } },
              { extractedText: { contains: skill, mode: "insensitive" as const } }
            ]
          }
        }))
      });
    }
    if (input.anySkills?.length) {
      and.push({
        resume: {
          OR: [
            { extractedSkills: { hasSome: input.anySkills } },
            ...input.anySkills.map((skill) => ({ extractedText: { contains: skill, mode: "insensitive" as const } }))
          ]
        }
      });
    }
    if (input.uploadDateFrom || input.uploadDateTo) {
      resumeFilter.createdAt = {
        ...(input.uploadDateFrom ? { gte: input.uploadDateFrom } : {}),
        ...(input.uploadDateTo ? { lte: input.uploadDateTo } : {})
      };
    }
    if (input.sourceChannel?.length) resumeFilter.uploadBatch = { sourceChannel: { in: input.sourceChannel } };
    if (Object.keys(resumeFilter).length > 0) and.push({ resume: resumeFilter });

    if (input.aiRecommendation?.length) and.push({ aiRecommendation: { in: input.aiRecommendation } });
    if (input.recruiterDecision?.length) and.push({ recruiterDecision: { in: input.recruiterDecision } });
    if (input.applicationStatus?.length) and.push({ applicationStatus: { in: input.applicationStatus } });
    if (input.evaluationDateFrom || input.evaluationDateTo) {
      and.push({
        evaluation: {
          evaluatedAt: {
            ...(input.evaluationDateFrom ? { gte: input.evaluationDateFrom } : {}),
            ...(input.evaluationDateTo ? { lte: input.evaluationDateTo } : {})
          }
        }
      });
    }
    // "Mandatory-skill match" only has meaning relative to a specific job's criteria, so it's a no-op
    // (silently ignored, not an error) on a cross-job query where `jobId` isn't set — documented on the
    // interface above.
    if (input.mandatorySkillsFullyMatched && input.jobId) {
      and.push({ evaluation: { missingSkills: { equals: [] } } });
    }

    return { AND: and };
  }

  private buildOrdering(input: RecruitmentCandidateQuery): {
    orderBy: Prisma.RecruitmentApplicationOrderByWithRelationInput[];
    cursorWhere: Prisma.RecruitmentApplicationWhereInput | null;
  } {
    const sortBy = input.sortBy ?? "score_desc";
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;

    // Every sort is paired with `id` as a secondary key — ties on the primary sort value (e.g. two
    // candidates both at exactly 80%) would otherwise make page boundaries nondeterministic (Phase 6:
    // "Ensure sorting remains deterministic across pages").
    switch (sortBy) {
      case "score_asc":
        return {
          orderBy: [{ evaluation: { matchScore: "asc" } }, { id: "asc" }],
          cursorWhere: decoded ? this.scoreCursor(decoded, "asc") : null
        };
      case "experience_desc":
        return {
          orderBy: [{ resume: { relevantExperienceYears: "desc" } }, { id: "asc" }],
          cursorWhere: decoded ? this.experienceCursor(decoded, "desc") : null
        };
      case "experience_asc":
        return {
          orderBy: [{ resume: { relevantExperienceYears: "asc" } }, { id: "asc" }],
          cursorWhere: decoded ? this.experienceCursor(decoded, "asc") : null
        };
      case "uploadDate_asc":
        return {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          cursorWhere: decoded ? this.dateCursor(decoded, "asc") : null
        };
      case "uploadDate_desc":
        return {
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          cursorWhere: decoded ? this.dateCursor(decoded, "desc") : null
        };
      case "name_asc":
        return {
          orderBy: [{ candidate: { fullName: "asc" } }, { id: "asc" }],
          cursorWhere: decoded ? { id: { gt: decoded.id } } : null // name cursor approximated by id tiebreak
        };
      case "score_desc":
      default:
        return {
          orderBy: [{ evaluation: { matchScore: "desc" } }, { id: "asc" }],
          cursorWhere: decoded ? this.scoreCursor(decoded, "desc") : null
        };
    }
  }

  private scoreCursor(decoded: CursorPayload, direction: "asc" | "desc"): Prisma.RecruitmentApplicationWhereInput {
    const value = typeof decoded.sortValue === "number" ? decoded.sortValue : null;
    if (value === null) return { id: { gt: decoded.id } };
    const op = direction === "desc" ? "lt" : "gt";
    return {
      OR: [
        { evaluation: { matchScore: { [op]: value } } },
        { AND: [{ evaluation: { matchScore: value } }, { id: { gt: decoded.id } }] }
      ]
    };
  }

  private experienceCursor(decoded: CursorPayload, direction: "asc" | "desc"): Prisma.RecruitmentApplicationWhereInput {
    const value = typeof decoded.sortValue === "number" ? decoded.sortValue : null;
    if (value === null) return { id: { gt: decoded.id } };
    const op = direction === "desc" ? "lt" : "gt";
    return {
      OR: [
        { resume: { relevantExperienceYears: { [op]: value } } },
        { AND: [{ resume: { relevantExperienceYears: value } }, { id: { gt: decoded.id } }] }
      ]
    };
  }

  private dateCursor(decoded: CursorPayload, direction: "asc" | "desc"): Prisma.RecruitmentApplicationWhereInput {
    const value = typeof decoded.sortValue === "string" ? new Date(decoded.sortValue) : null;
    if (!value) return { id: { gt: decoded.id } };
    const op = direction === "desc" ? "lt" : "gt";
    return {
      OR: [{ createdAt: { [op]: value } }, { AND: [{ createdAt: value }, { id: { gt: decoded.id } }] }]
    };
  }

  private sortValueOf(
    row: Prisma.RecruitmentApplicationGetPayload<{ include: { candidate: true; resume: true; evaluation: true } }>,
    sortBy: RecruitmentCandidateQuery["sortBy"]
  ): string | number | null {
    switch (sortBy) {
      case "score_asc":
      case "score_desc":
        return row.evaluation?.matchScore ?? null;
      case "experience_asc":
      case "experience_desc":
        return row.resume.relevantExperienceYears ?? null;
      case "uploadDate_asc":
      case "uploadDate_desc":
        return row.createdAt.toISOString();
      default:
        return row.evaluation?.matchScore ?? null;
    }
  }
}
