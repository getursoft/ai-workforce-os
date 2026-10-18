import {
  RecruitmentAiRecommendation,
  RecruitmentDecision,
  RecruitmentEmploymentType,
  RecruitmentJobStatus,
  RecruitmentParsingStatus,
  RecruitmentWorkMode
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";

export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

/** Shape of `RecruitmentJob.requiredCriteria` — the only copy the scoring engine reads from. */
export class RequiredCriteriaDto {
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) mandatorySkills!: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) preferredSkills?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) certifications?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) educationRequirements?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) domainKnowledge?: string[];
}

/** Shape of `RecruitmentJob.scoringConfig` — validated to sum to 100 in the service, never trusted
 * unvalidated from the client (Phase 11). */
export class ScoringConfigDto {
  @IsNumber() @Min(0) @Max(100) mandatorySkillWeight!: number;
  @IsNumber() @Min(0) @Max(100) preferredSkillWeight!: number;
  @IsNumber() @Min(0) @Max(100) experienceWeight!: number;
  @IsNumber() @Min(0) @Max(100) projectExperienceWeight!: number;
  @IsNumber() @Min(0) @Max(100) certificationWeight!: number;
}

export class CreateJobDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) description!: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(160) location?: string;
  @IsOptional() @IsEnum(RecruitmentEmploymentType) employmentType?: RecruitmentEmploymentType;
  @IsOptional() @IsEnum(RecruitmentWorkMode) workMode?: RecruitmentWorkMode;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minExperienceYears?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxExperienceYears?: number;
  @ValidateNested() @Type(() => RequiredCriteriaDto) requiredCriteria!: RequiredCriteriaDto;
  @IsOptional() @IsObject() aiSuggestedCriteria?: Record<string, unknown>;
  @IsOptional() @IsString() responsibilities?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) salaryRangeMin?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) salaryRangeMax?: number;
  @IsOptional() @IsString() @MaxLength(3) salaryCurrency?: string;
  @IsOptional() @IsString() @MaxLength(160) hiringManager?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) numberOfOpenings?: number;
  @IsOptional() @IsDateString() applicationDeadline?: string;
  @ValidateNested() @Type(() => ScoringConfigDto) scoringConfig!: ScoringConfigDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) recommendationThreshold?: number;
}

export class UpdateJobDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(1) description?: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(160) location?: string;
  @IsOptional() @IsEnum(RecruitmentEmploymentType) employmentType?: RecruitmentEmploymentType;
  @IsOptional() @IsEnum(RecruitmentWorkMode) workMode?: RecruitmentWorkMode;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minExperienceYears?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxExperienceYears?: number;
  @IsOptional() @ValidateNested() @Type(() => RequiredCriteriaDto) requiredCriteria?: RequiredCriteriaDto;
  @IsOptional() @IsString() responsibilities?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) salaryRangeMin?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) salaryRangeMax?: number;
  @IsOptional() @IsString() @MaxLength(3) salaryCurrency?: string;
  @IsOptional() @IsString() @MaxLength(160) hiringManager?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) numberOfOpenings?: number;
  @IsOptional() @IsDateString() applicationDeadline?: string;
  @IsOptional() @ValidateNested() @Type(() => ScoringConfigDto) scoringConfig?: ScoringConfigDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) recommendationThreshold?: number;
  @IsOptional() @IsEnum(RecruitmentJobStatus) status?: RecruitmentJobStatus;
}

export class ListJobsDto extends PageDto {
  @IsOptional() @IsEnum(RecruitmentJobStatus) status?: RecruitmentJobStatus;
  @IsOptional() @IsString() @MaxLength(160) search?: string;
}

/** The AI-assisted JD-parsing endpoint's input — a pasted or extracted job description, parsed into
 * suggested criteria the recruiter must confirm or edit before it's ever persisted (Phase 2). */
export class ParseJobDescriptionDto {
  @IsString() @MinLength(1) @MaxLength(20000) text!: string;
}

export class ListCandidatesDto extends PageDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) minScore?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) maxScore?: number;
  @IsOptional() @IsEnum(RecruitmentAiRecommendation) aiRecommendation?: RecruitmentAiRecommendation;
  @IsOptional() @IsEnum(RecruitmentDecision) recruiterDecision?: RecruitmentDecision;
  @IsOptional() @IsEnum(RecruitmentParsingStatus) parsingStatus?: RecruitmentParsingStatus;
  @IsOptional() @IsString() @MaxLength(160) search?: string;
  @IsOptional() @IsString() sortBy?: "matchScore" | "createdAt";
}

export class ReviewApplicationDto {
  @IsEnum(RecruitmentDecision) recruiterDecision!: RecruitmentDecision;
  @IsOptional() @IsString() @MaxLength(2000) overrideReason?: string;
}

/** Phase 6's single shared candidate-query shape — posted as a body (not query-string) since it carries
 * arrays and date ranges that don't serialize cleanly as GET params; the website still exposes these as
 * URL query parameters at its own layer for shareable views (Phase 10), independent of this transport. */
export class AdvancedCandidateQueryDto {
  @IsOptional() @IsUUID() jobId?: string;

  @IsOptional() @Type(() => Number) @IsNumber() scoreGreaterThan?: number;
  @IsOptional() @Type(() => Number) @IsNumber() scoreGreaterThanOrEqual?: number;
  @IsOptional() @Type(() => Number) @IsNumber() scoreLessThan?: number;
  @IsOptional() @Type(() => Number) @IsNumber() scoreLessThanOrEqual?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) currentCity?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) currentState?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) currentCountry?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) region?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) preferredWorkLocation?: string[];
  @IsOptional() @IsBoolean() willingToRelocate?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minTotalExperienceYears?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxTotalExperienceYears?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minRelevantExperienceYears?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxRelevantExperienceYears?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) allSkills?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) anySkills?: string[];
  @IsOptional() @IsBoolean() mandatorySkillsFullyMatched?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsEnum(RecruitmentAiRecommendation, { each: true }) aiRecommendation?: RecruitmentAiRecommendation[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsEnum(RecruitmentDecision, { each: true }) recruiterDecision?: RecruitmentDecision[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) applicationStatus?: string[];
  @IsOptional() @IsDateString() uploadDateFrom?: string;
  @IsOptional() @IsDateString() uploadDateTo?: string;
  @IsOptional() @IsDateString() evaluationDateFrom?: string;
  @IsOptional() @IsDateString() evaluationDateTo?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsString({ each: true }) sourceChannel?: ("WEBSITE" | "WHATSAPP")[];
  @IsOptional() @IsString() @MaxLength(160) search?: string;

  @IsOptional() @IsString() sortBy?:
    | "score_desc" | "score_asc" | "experience_desc" | "experience_asc"
    | "uploadDate_desc" | "uploadDate_asc" | "name_asc";
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class RequestExportDto {
  @IsEnum(["ALL_AUTHORIZED", "FILTERED", "SELECTED", "CURRENT_JOB", "CROSS_JOB"]) scope!:
    "ALL_AUTHORIZED" | "FILTERED" | "SELECTED" | "CURRENT_JOB" | "CROSS_JOB";
  @IsEnum(["CSV", "XLSX"]) format!: "CSV" | "XLSX";
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @ValidateNested() @Type(() => AdvancedCandidateQueryDto) filters?: AdvancedCandidateQueryDto;
  @IsOptional() @IsArray() @ArrayMaxSize(22) @IsString({ each: true }) fieldSelection?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID(undefined, { each: true }) selectedApplicationIds?: string[];
}

export class SaveFilterPresetDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ValidateNested() @Type(() => AdvancedCandidateQueryDto) filters!: AdvancedCandidateQueryDto;
}

export class CorrectCandidateLocationDto {
  @IsOptional() @IsString() @MaxLength(120) currentCity?: string | null;
  @IsOptional() @IsString() @MaxLength(120) currentState?: string | null;
  @IsOptional() @IsString() @MaxLength(120) currentCountry?: string | null;
  @IsOptional() @IsString() @MaxLength(120) normalizedRegion?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) preferredWorkLocations?: string[] | null;
  @IsOptional() @IsBoolean() willingToRelocate?: boolean | null;
  @IsOptional() @IsString() @MaxLength(80) noticePeriod?: string | null;
}

export class UpdateRecruitmentSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => ScoringConfigDto) scoringConfig?: ScoringConfigDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) recommendationThreshold?: number;
}

export class RetryResumeDto {
  @IsOptional() @IsUUID("4", { each: true }) @IsArray() resumeIds?: string[];
}

/** Sprint 7.17 (Phase 5) — client-reportable calling-audit events only. Deliberately excludes every
 * provider-attested state (CALL_PROVIDER_ACCEPTED, CALL_RINGING, CALL_CONNECTED, COMPLETED, INITIATED) —
 * a client can report that it showed a number or opened a tel: link, never that a call actually
 * connected; those states only ever come from a verified provider callback. */
export class RecordCallEventDto {
  @IsEnum(["CONTACT_VIEWED", "CALL_ACTION_REQUESTED", "CALL_LINK_OPENED", "CALL_CANCELLED"])
  status!: "CONTACT_VIEWED" | "CALL_ACTION_REQUESTED" | "CALL_LINK_OPENED" | "CALL_CANCELLED";
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() applicationId?: string;
  @IsOptional() @IsString() @MaxLength(32) channel?: string;
  @IsOptional() @IsEnum(["WEBSITE", "IOS", "WHATSAPP"]) platform?: "WEBSITE" | "IOS" | "WHATSAPP";
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
