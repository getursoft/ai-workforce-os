import type { ApiClient } from "../../lib/api-client";

export type RecruitmentJobStatus = "DRAFT" | "OPEN" | "ON_HOLD" | "CLOSED";
export type RecruitmentEmploymentType = "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP" | "TEMPORARY";
export type RecruitmentWorkMode = "ONSITE" | "REMOTE" | "HYBRID";
export type RecruitmentParsingStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
export type RecruitmentAiRecommendation = "RECOMMENDED_FOR_SHORTLIST" | "BELOW_MATCH_THRESHOLD" | "REVIEW_REQUIRED";
export type RecruitmentDecision =
  | "PENDING_REVIEW"
  | "SHORTLISTED"
  | "NOT_SELECTED"
  | "INTERVIEW_SCHEDULED"
  | "INTERVIEW_COMPLETED"
  | "ON_HOLD"
  | "HIRED";

export interface RequiredCriteria {
  mandatorySkills: string[];
  preferredSkills?: string[];
  certifications?: string[];
  educationRequirements?: string[];
  domainKnowledge?: string[];
}

export interface ScoringConfig {
  mandatorySkillWeight: number;
  preferredSkillWeight: number;
  experienceWeight: number;
  projectExperienceWeight: number;
  certificationWeight: number;
}

export interface RecruitmentJob {
  id: string;
  jobCode: string;
  title: string;
  description: string;
  department: string | null;
  location: string | null;
  employmentType: RecruitmentEmploymentType | null;
  workMode: RecruitmentWorkMode | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  requiredCriteria: RequiredCriteria;
  scoringConfig: ScoringConfig;
  recommendationThreshold: number;
  status: RecruitmentJobStatus;
  numberOfOpenings: number;
  createdAt: string;
  totalResumes: number;
  aiRecommendedCount: number;
  recruiterShortlistedCount: number;
}

export interface RecruitmentCandidate {
  id: string;
  fullName: string | null;
  mobileNumber: string | null;
  email: string | null;
  currentCity: string | null;
  currentState: string | null;
  currentCountry: string | null;
  normalizedRegion: string | null;
  preferredWorkLocations: string[];
  willingToRelocate: boolean | null;
  workModePreference: RecruitmentWorkMode | null;
  noticePeriod: string | null;
  locationSource: string | null;
}

export interface RecruitmentResume {
  id: string;
  resumeCode: string;
  fileName: string;
  parsingStatus: RecruitmentParsingStatus;
  parsingError: string | null;
  totalExperienceYears: number | null;
  relevantExperienceYears: number | null;
  extractedSkills: string[];
}

export interface RecruitmentEvaluation {
  matchScore: number | null;
  scoreBreakdown: Record<string, { weight: number; achieved: number }> | null;
  matchedSkills: string[] | null;
  missingSkills: string[] | null;
  evidence: Array<{ requirement: string; evidence: string }> | null;
  explanation: string | null;
  warnings: string[] | null;
  evaluationStatus: "PENDING" | "COMPLETED" | "FAILED";
}

export interface RecruitmentApplication {
  id: string;
  jobId: string;
  candidate: RecruitmentCandidate;
  resume: RecruitmentResume;
  evaluation: RecruitmentEvaluation | null;
  aiRecommendation: RecruitmentAiRecommendation | null;
  recruiterDecision: RecruitmentDecision;
  overrideReason: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UploadBatch {
  id: string;
  totalFiles: number;
  queuedFiles: number;
  processingFiles: number;
  completedFiles: number;
  failedFiles: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  status: string;
}

// --- Sprint 7.16 Phase 6/10/11 — shared advanced query + export types -------------------------------

export interface AdvancedCandidateQuery {
  jobId?: string;
  scoreGreaterThan?: number;
  scoreGreaterThanOrEqual?: number;
  scoreLessThan?: number;
  scoreLessThanOrEqual?: number;
  currentCity?: string[];
  currentState?: string[];
  currentCountry?: string[];
  region?: string[];
  preferredWorkLocation?: string[];
  willingToRelocate?: boolean;
  minTotalExperienceYears?: number;
  maxTotalExperienceYears?: number;
  minRelevantExperienceYears?: number;
  maxRelevantExperienceYears?: number;
  allSkills?: string[];
  anySkills?: string[];
  mandatorySkillsFullyMatched?: boolean;
  aiRecommendation?: RecruitmentAiRecommendation[];
  recruiterDecision?: RecruitmentDecision[];
  applicationStatus?: string[];
  uploadDateFrom?: string;
  uploadDateTo?: string;
  evaluationDateFrom?: string;
  evaluationDateTo?: string;
  sourceChannel?: ("WEBSITE" | "WHATSAPP")[];
  search?: string;
  sortBy?:
    | "score_desc" | "score_asc" | "experience_desc" | "experience_asc"
    | "uploadDate_desc" | "uploadDate_asc" | "name_asc";
  cursor?: string;
  limit?: number;
}

export interface CandidateQueryResult {
  items: RecruitmentApplication[];
  nextCursor: string | null;
  totalCount: number;
}

export type ExportField =
  | "jobId" | "jobTitle" | "resumeId" | "candidateName" | "mobileNumber" | "email"
  | "currentCity" | "currentState" | "currentCountry" | "preferredLocations" | "willingToRelocate"
  | "noticePeriod" | "totalExperience" | "relevantExperience" | "extractedSkills" | "matchedSkills"
  | "missingSkills" | "atsScore" | "aiRecommendation" | "recruiterDecision" | "applicationStatus" | "evaluationDate";

export interface ExportJobStatus {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "EXPIRED" | "CANCELLED";
  rowCount: number | null;
  errorMessage: string | null;
  downloadToken: string | null;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: AdvancedCandidateQuery;
  createdAt: string;
}

function toQuery(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)])
  );
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function createRecruitmentApi(client: ApiClient) {
  return {
    listJobs: (query: { page?: number; pageSize?: number; status?: RecruitmentJobStatus; search?: string } = {}) =>
      client.request<Page<RecruitmentJob>>(`/recruitment/jobs${toQuery(query)}`),
    getJob: (id: string) => client.request<RecruitmentJob>(`/recruitment/jobs/${id}`),
    createJob: (input: {
      title: string;
      description: string;
      department?: string;
      location?: string;
      employmentType?: RecruitmentEmploymentType;
      workMode?: RecruitmentWorkMode;
      minExperienceYears?: number;
      maxExperienceYears?: number;
      requiredCriteria: RequiredCriteria;
      scoringConfig: ScoringConfig;
      recommendationThreshold?: number;
      responsibilities?: string;
      hiringManager?: string;
      numberOfOpenings?: number;
    }) => client.request<RecruitmentJob>("/recruitment/jobs", { method: "POST", body: JSON.stringify(input) }),
    updateJob: (id: string, input: Record<string, unknown>) =>
      client.request<RecruitmentJob>(`/recruitment/jobs/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    closeJob: (id: string) => client.request<RecruitmentJob>(`/recruitment/jobs/${id}/close`, { method: "POST" }),
    parseJobDescription: (text: string) =>
      client.request<RequiredCriteria>("/recruitment/jobs/parse-description", {
        method: "POST",
        body: JSON.stringify({ text })
      }),
    uploadResumeBatch: (jobId: string, files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      return client.request<{ batchId: string; totalFiles: number; results: unknown[] }>(
        `/recruitment/jobs/${jobId}/resumes/batch`,
        { method: "POST", body: form }
      );
    },
    batchStatus: (batchId: string) => client.request<UploadBatch>(`/recruitment/batches/${batchId}`),
    retryBatch: (batchId: string, resumeIds?: string[]) =>
      client.request<{ retried: number }>(`/recruitment/batches/${batchId}/retry`, {
        method: "POST",
        body: JSON.stringify({ resumeIds })
      }),
    listCandidates: (
      jobId: string,
      query: {
        page?: number;
        pageSize?: number;
        minScore?: number;
        maxScore?: number;
        aiRecommendation?: RecruitmentAiRecommendation;
        recruiterDecision?: RecruitmentDecision;
        search?: string;
        sortBy?: "matchScore" | "createdAt";
      } = {}
    ) => client.request<Page<RecruitmentApplication>>(`/recruitment/jobs/${jobId}/candidates${toQuery(query)}`),
    exportCandidatesUrl: (jobId: string) => `/recruitment/jobs/${jobId}/export`,
    exportCandidatesXlsxUrl: (jobId: string) => `/recruitment/jobs/${jobId}/export.xlsx`,
    getApplication: (applicationId: string) =>
      client.request<RecruitmentApplication & { job: RecruitmentJob }>(`/recruitment/applications/${applicationId}`),
    reviewApplication: (applicationId: string, recruiterDecision: RecruitmentDecision, overrideReason?: string) =>
      client.request<RecruitmentApplication>(`/recruitment/applications/${applicationId}/review`, {
        method: "POST",
        body: JSON.stringify({ recruiterDecision, overrideReason })
      }),
    resumeDownloadUrl: (resumeId: string) =>
      client.request<{ url: string }>(`/recruitment/resumes/${resumeId}/download-url`),

    // --- Sprint 7.17 Phase 5: calling audit trail ---------------------------------------------------
    /** `status` is restricted to the client-reportable subset the backend's RecordCallEventDto accepts
     * — CONTACT_VIEWED/CALL_ACTION_REQUESTED/CALL_LINK_OPENED/CALL_CANCELLED. The server independently
     * requires `recruitment.candidates.call` for the latter three (not just `.contact`), and a request
     * missing it fails with a 403 (ApiError.kind === "authorization") the caller must handle, not a
     * state the UI can decide for itself ahead of time. */
    recordCallEvent: (
      candidateId: string,
      input: { status: "CONTACT_VIEWED" | "CALL_ACTION_REQUESTED" | "CALL_LINK_OPENED" | "CALL_CANCELLED"; jobId?: string; applicationId?: string }
    ) =>
      client.request<{ id: string }>(`/recruitment/candidates/${candidateId}/call-log`, {
        method: "POST",
        body: JSON.stringify({ ...input, platform: "WEBSITE", channel: "MANUAL_CLICK_TO_CALL" })
      }),

    // --- Sprint 7.16 Phase 6/10/11 ---------------------------------------------------------------
    searchCandidates: (query: AdvancedCandidateQuery) =>
      client.request<CandidateQueryResult>("/recruitment/candidates/search", {
        method: "POST",
        body: JSON.stringify(query)
      }),
    requestExport: (input: {
      scope: "ALL_AUTHORIZED" | "FILTERED" | "SELECTED" | "CURRENT_JOB" | "CROSS_JOB";
      format: "CSV" | "XLSX";
      jobId?: string;
      filters?: AdvancedCandidateQuery;
      fieldSelection?: ExportField[];
      selectedApplicationIds?: string[];
    }) =>
      client.request<{ exportJobId: string; status: string; rowCount: number; downloadToken?: string }>(
        "/recruitment/candidates/export",
        { method: "POST", body: JSON.stringify(input) }
      ),
    exportStatus: (exportJobId: string) =>
      client.request<ExportJobStatus>(`/recruitment/candidates/export/${exportJobId}`),
    exportDownloadUrl: (exportJobId: string, token: string) =>
      client.request<{ url: string }>(`/recruitment/candidates/export/${exportJobId}/download?token=${encodeURIComponent(token)}`),
    cancelExport: (exportJobId: string) =>
      client.request<ExportJobStatus>(`/recruitment/candidates/export/${exportJobId}/cancel`, { method: "POST" }),
    listFilterPresets: () => client.request<FilterPreset[]>("/recruitment/candidates/filter-presets"),
    saveFilterPreset: (name: string, filters: AdvancedCandidateQuery) =>
      client.request<FilterPreset>("/recruitment/candidates/filter-presets", {
        method: "POST",
        body: JSON.stringify({ name, filters })
      }),
    deleteFilterPreset: (presetId: string) =>
      client.request<{ deleted: boolean }>(`/recruitment/candidates/filter-presets/${presetId}`, { method: "DELETE" }),
    correctCandidateLocation: (
      candidateId: string,
      input: {
        currentCity?: string | null;
        currentState?: string | null;
        currentCountry?: string | null;
        normalizedRegion?: string | null;
        preferredWorkLocations?: string[] | null;
        willingToRelocate?: boolean | null;
        noticePeriod?: string | null;
      }
    ) =>
      client.request<RecruitmentCandidate>(`/recruitment/candidates/${candidateId}/location`, {
        method: "POST",
        body: JSON.stringify(input)
      }),
    backfillLocations: () =>
      client.request<{ requeued: number }>("/recruitment/candidates/backfill-locations", { method: "POST" })
  };
}
