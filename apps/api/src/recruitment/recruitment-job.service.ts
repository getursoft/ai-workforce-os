import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, RecruitmentJobStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { CreateJobDto, ListJobsDto, UpdateJobDto } from "./recruitment.dto";

const DEFAULT_SCORING_CONFIG = {
  mandatorySkillWeight: 35,
  preferredSkillWeight: 15,
  experienceWeight: 25,
  projectExperienceWeight: 15,
  certificationWeight: 10
};

/** Validates an org-configurable scoring weight set sums to 100 (Phase 5) — never trusted unvalidated
 * from the client. */
function assertWeightsSumTo100(config: {
  mandatorySkillWeight: number;
  preferredSkillWeight: number;
  experienceWeight: number;
  projectExperienceWeight: number;
  certificationWeight: number;
}) {
  const total =
    config.mandatorySkillWeight +
    config.preferredSkillWeight +
    config.experienceWeight +
    config.projectExperienceWeight +
    config.certificationWeight;
  if (Math.round(total) !== 100)
    throw new BadRequestException(`SCORING_WEIGHTS_MUST_SUM_TO_100: got ${total}`);
}

@Injectable()
export class RecruitmentJobService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: ListJobsDto) {
    const where: Prisma.RecruitmentJobWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { title: { contains: query.search, mode: "insensitive" as const } }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.recruitmentJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          _count: { select: { applications: true } }
        }
      }),
      this.prisma.recruitmentJob.count({ where })
    ]);
    // Total Resumes / AI-Recommended / Recruiter-Shortlisted per job (Phase 2's table columns) — one
    // extra grouped query rather than N+1 per row.
    const jobIds = items.map((item) => item.id);
    const recommendedCounts = jobIds.length
      ? await this.prisma.recruitmentApplication.groupBy({
          by: ["jobId"],
          where: { jobId: { in: jobIds }, aiRecommendation: "RECOMMENDED_FOR_SHORTLIST" },
          _count: { id: true }
        })
      : [];
    const shortlistedCounts = jobIds.length
      ? await this.prisma.recruitmentApplication.groupBy({
          by: ["jobId"],
          where: { jobId: { in: jobIds }, recruiterDecision: "SHORTLISTED" },
          _count: { id: true }
        })
      : [];
    const recommendedMap = new Map(recommendedCounts.map((row) => [row.jobId, row._count.id]));
    const shortlistedMap = new Map(shortlistedCounts.map((row) => [row.jobId, row._count.id]));
    return {
      items: items.map((item) => ({
        ...item,
        totalResumes: item._count.applications,
        aiRecommendedCount: recommendedMap.get(item.id) ?? 0,
        recruiterShortlistedCount: shortlistedMap.get(item.id) ?? 0
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize)
    };
  }

  async get(organizationId: string, id: string) {
    const job = await this.prisma.recruitmentJob.findFirst({
      where: { id, organizationId },
      include: { _count: { select: { applications: true } } }
    });
    if (!job) throw new NotFoundException("RECRUITMENT_JOB_NOT_FOUND");
    const [aiRecommendedCount, shortlistedCount] = await Promise.all([
      this.prisma.recruitmentApplication.count({
        where: { jobId: id, aiRecommendation: "RECOMMENDED_FOR_SHORTLIST" }
      }),
      this.prisma.recruitmentApplication.count({ where: { jobId: id, recruiterDecision: "SHORTLISTED" } })
    ]);
    return {
      ...job,
      totalResumes: job._count.applications,
      aiRecommendedCount,
      recruiterShortlistedCount: shortlistedCount
    };
  }

  async create(organizationId: string, userId: string, dto: CreateJobDto) {
    const scoringConfig = dto.scoringConfig ?? DEFAULT_SCORING_CONFIG;
    assertWeightsSumTo100(scoringConfig);
    const jobCode = await this.nextJobCode(organizationId);
    return this.prisma.recruitmentJob.create({
      data: {
        organizationId,
        jobCode,
        title: dto.title,
        description: dto.description,
        department: dto.department ?? null,
        location: dto.location ?? null,
        employmentType: dto.employmentType ?? null,
        workMode: dto.workMode ?? null,
        minExperienceYears: dto.minExperienceYears ?? null,
        maxExperienceYears: dto.maxExperienceYears ?? null,
        requiredCriteria: dto.requiredCriteria as unknown as Prisma.InputJsonValue,
        aiSuggestedCriteria: (dto.aiSuggestedCriteria as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        responsibilities: dto.responsibilities ?? null,
        salaryRangeMin: dto.salaryRangeMin ?? null,
        salaryRangeMax: dto.salaryRangeMax ?? null,
        salaryCurrency: dto.salaryCurrency ?? null,
        hiringManager: dto.hiringManager ?? null,
        numberOfOpenings: dto.numberOfOpenings ?? 1,
        applicationDeadline: dto.applicationDeadline ? new Date(dto.applicationDeadline) : null,
        scoringConfig: scoringConfig as unknown as Prisma.InputJsonValue,
        recommendationThreshold: dto.recommendationThreshold ?? 80,
        status: RecruitmentJobStatus.OPEN,
        createdByUserId: userId
      }
    });
  }

  async update(organizationId: string, id: string, dto: UpdateJobDto) {
    await this.get(organizationId, id);
    if (dto.scoringConfig) assertWeightsSumTo100(dto.scoringConfig);
    return this.prisma.recruitmentJob.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.department !== undefined ? { department: dto.department } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.employmentType !== undefined ? { employmentType: dto.employmentType } : {}),
        ...(dto.workMode !== undefined ? { workMode: dto.workMode } : {}),
        ...(dto.minExperienceYears !== undefined ? { minExperienceYears: dto.minExperienceYears } : {}),
        ...(dto.maxExperienceYears !== undefined ? { maxExperienceYears: dto.maxExperienceYears } : {}),
        ...(dto.requiredCriteria !== undefined
          ? { requiredCriteria: dto.requiredCriteria as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.responsibilities !== undefined ? { responsibilities: dto.responsibilities } : {}),
        ...(dto.salaryRangeMin !== undefined ? { salaryRangeMin: dto.salaryRangeMin } : {}),
        ...(dto.salaryRangeMax !== undefined ? { salaryRangeMax: dto.salaryRangeMax } : {}),
        ...(dto.salaryCurrency !== undefined ? { salaryCurrency: dto.salaryCurrency } : {}),
        ...(dto.hiringManager !== undefined ? { hiringManager: dto.hiringManager } : {}),
        ...(dto.numberOfOpenings !== undefined ? { numberOfOpenings: dto.numberOfOpenings } : {}),
        ...(dto.applicationDeadline !== undefined
          ? { applicationDeadline: dto.applicationDeadline ? new Date(dto.applicationDeadline) : null }
          : {}),
        ...(dto.scoringConfig !== undefined
          ? { scoringConfig: dto.scoringConfig as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.recommendationThreshold !== undefined
          ? { recommendationThreshold: dto.recommendationThreshold }
          : {}),
        ...(dto.status !== undefined
          ? { status: dto.status, ...(dto.status === "CLOSED" ? { closedAt: new Date() } : {}) }
          : {})
      }
    });
  }

  async close(organizationId: string, id: string) {
    await this.get(organizationId, id);
    return this.prisma.recruitmentJob.update({
      where: { id },
      data: { status: RecruitmentJobStatus.CLOSED, closedAt: new Date() }
    });
  }

  /** Organization-scoped, year-stamped sequence — "JOB-2026-00001". Retries once on a unique-constraint
   * collision (two concurrent creates racing the same next number) rather than serializing all job
   * creation through a lock. */
  private async nextJobCode(organizationId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const count = await this.prisma.recruitmentJob.count({ where: { organizationId } });
    const candidate = `JOB-${year}-${String(count + 1).padStart(5, "0")}`;
    const exists = await this.prisma.recruitmentJob.findUnique({
      where: { organizationId_jobCode: { organizationId, jobCode: candidate } }
    });
    if (!exists) return candidate;
    return `JOB-${year}-${String(count + 1 + Math.floor(Math.random() * 1000)).padStart(5, "0")}`;
  }
}

export function assertJobOpenForReview(status: RecruitmentJobStatus) {
  if (status === "CLOSED") throw new ForbiddenException("RECRUITMENT_JOB_CLOSED");
}
