"use client";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import {
  Alert,
  BackLink,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Skeleton,
  SummaryCard
} from "../../components/ui";
import {
  createRecruitmentApi,
  type RecruitmentAiRecommendation,
  type RecruitmentApplication,
  type RecruitmentDecision,
  type RecruitmentJobStatus
} from "./recruitment-api";
import { AdvancedFilterPanel } from "./recruitment-advanced-filters";

const jobsKey = ["recruitment", "jobs"] as const;

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createRecruitmentApi(client), [client]);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const STATUS_TONE: Record<RecruitmentJobStatus, "neutral" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral",
  OPEN: "success",
  ON_HOLD: "warning",
  CLOSED: "danger"
};

// ---------------------------------------------------------------------------------------------------
// Job Openings — the Phase 2 portfolio table.
// ---------------------------------------------------------------------------------------------------

export function RecruitmentJobsPage() {
  const api = useApi();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const listQuery = useQuery({
    queryKey: [...jobsKey, "list", page],
    queryFn: () => api.listJobs({ page, pageSize: 20 })
  });
  const items = listQuery.data?.items ?? [];

  return (
    <AccessGate permission="recruitment.jobs.read">
      <section className="admin-page">
        <PageHeader
          title="Job Openings"
          eyebrow="AI Recruitment Consultant"
          description="Internal recruitment operations — job portfolio, bulk resume intake, and AI-assisted candidate matching for your own hiring team."
          action={
            <AccessGate permission="recruitment.jobs.create">
              <Button onClick={() => router.push("/dashboard/recruitment/jobs/new")}>Create Job</Button>
            </AccessGate>
          }
        />

        {listQuery.isLoading ? (
          <Skeleton />
        ) : listQuery.isError ? (
          <Alert tone="danger" title="Unable to load job openings">
            <Button onClick={() => listQuery.refetch()}>Retry</Button>
          </Alert>
        ) : items.length ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Job Title</th>
                    <th>Department</th>
                    <th>Location</th>
                    <th>Experience</th>
                    <th>Total Resumes</th>
                    <th>AI-Recommended</th>
                    <th>Shortlisted</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((job) => (
                    <tr
                      key={job.id}
                      onClick={() => router.push(`/dashboard/recruitment/jobs/${job.id}`)}
                      style={{ cursor: "pointer" }}
                    >
                      <td><strong>{job.jobCode}</strong></td>
                      <td>{job.title}</td>
                      <td>{job.department ?? "—"}</td>
                      <td>{job.location ?? "—"}</td>
                      <td>
                        {job.minExperienceYears ?? 0}
                        {job.maxExperienceYears ? `–${job.maxExperienceYears}` : "+"} yrs
                      </td>
                      <td>{job.totalResumes}</td>
                      <td>{job.aiRecommendedCount}</td>
                      <td>{job.recruiterShortlistedCount}</td>
                      <td><Badge tone={STATUS_TONE[job.status]}>{job.status.replace(/_/g, " ")}</Badge></td>
                      <td>{formatDate(job.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>Previous</Button>
              <span>Page {page} of {Math.max(1, listQuery.data?.totalPages ?? 1)}</span>
              <Button disabled={page >= (listQuery.data?.totalPages ?? 1)} onClick={() => setPage((x) => x + 1)}>
                Next
              </Button>
            </div>
          </>
        ) : (
          <EmptyState
            title="No job openings yet"
            description="Create your first job opening to start uploading and matching candidate resumes against it."
          />
        )}
      </section>
    </AccessGate>
  );
}

// ---------------------------------------------------------------------------------------------------
// Create Job — Phase 2's required/optional fields, with AI-assisted JD parsing the recruiter must
// confirm/edit before it's ever persisted.
// ---------------------------------------------------------------------------------------------------

export function CreateJobPage() {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [minExperience, setMinExperience] = useState("0");
  const [maxExperience, setMaxExperience] = useState("");
  const [mandatorySkills, setMandatorySkills] = useState("");
  const [preferredSkills, setPreferredSkills] = useState("");
  const [certifications, setCertifications] = useState("");
  const [hiringManager, setHiringManager] = useState("");
  const [numberOfOpenings, setNumberOfOpenings] = useState("1");

  const parseMutation = useMutation({
    mutationFn: () => api.parseJobDescription(description),
    onSuccess: (result) => {
      if (result.mandatorySkills.length) setMandatorySkills(result.mandatorySkills.join(", "));
      if (result.preferredSkills?.length) setPreferredSkills(result.preferredSkills.join(", "));
      if (result.certifications?.length) setCertifications(result.certifications.join(", "));
    }
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createJob({
        title,
        description,
        ...(department ? { department } : {}),
        ...(location ? { location } : {}),
        minExperienceYears: Number(minExperience) || 0,
        ...(maxExperience ? { maxExperienceYears: Number(maxExperience) } : {}),
        requiredCriteria: {
          mandatorySkills: splitList(mandatorySkills),
          preferredSkills: splitList(preferredSkills),
          certifications: splitList(certifications)
        },
        scoringConfig: {
          mandatorySkillWeight: 35,
          preferredSkillWeight: 15,
          experienceWeight: 25,
          projectExperienceWeight: 15,
          certificationWeight: 10
        },
        ...(hiringManager ? { hiringManager } : {}),
        numberOfOpenings: Number(numberOfOpenings) || 1
      }),
    onSuccess: (job) => {
      void qc.invalidateQueries({ queryKey: jobsKey });
      router.push(`/dashboard/recruitment/jobs/${job.id}`);
    }
  });

  return (
    <AccessGate permission="recruitment.jobs.create">
      <section className="admin-page">
        <BackLink href="/dashboard/recruitment/jobs" label="Back to Job Openings" />
        <PageHeader title="Create Job" description="Define the role and the criteria the AI Recruitment Consultant will match resumes against." />

        <Card style={{ display: "grid", gap: 16, maxWidth: 720 }}>
          <div className="ui-field">
            <Label htmlFor="job-title">Job Title *</Label>
            <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="ui-field">
            <Label htmlFor="job-description">Job Description *</Label>
            <textarea
              id="job-description"
              className="ui-input"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Paste the full job description — use 'Suggest criteria' below to have the AI extract required skills, certifications, and experience."
            />
            <Button
              variant="ghost"
              disabled={!description.trim() || parseMutation.isPending}
              onClick={() => parseMutation.mutate()}
              style={{ marginTop: 8 }}
            >
              {parseMutation.isPending ? "Analyzing…" : "Suggest criteria from description"}
            </Button>
            {parseMutation.isSuccess ? (
              <Alert tone="success" title="Suggested criteria filled in below — review and edit before creating." />
            ) : null}
          </div>
          <div className="ui-field">
            <Label htmlFor="job-mandatory">Required Skills (comma-separated) *</Label>
            <Input id="job-mandatory" value={mandatorySkills} onChange={(e) => setMandatorySkills(e.target.value)} />
          </div>
          <div className="ui-field">
            <Label htmlFor="job-preferred">Preferred Skills (comma-separated)</Label>
            <Input id="job-preferred" value={preferredSkills} onChange={(e) => setPreferredSkills(e.target.value)} />
          </div>
          <div className="ui-field">
            <Label htmlFor="job-certs">Certifications (comma-separated)</Label>
            <Input id="job-certs" value={certifications} onChange={(e) => setCertifications(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="ui-field">
              <Label htmlFor="job-min-exp">Minimum Experience (years) *</Label>
              <Input id="job-min-exp" type="number" min={0} value={minExperience} onChange={(e) => setMinExperience(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="job-max-exp">Maximum Experience (years)</Label>
              <Input id="job-max-exp" type="number" min={0} value={maxExperience} onChange={(e) => setMaxExperience(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="ui-field">
              <Label htmlFor="job-department">Department</Label>
              <Input id="job-department" value={department} onChange={(e) => setDepartment(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="job-location">Location</Label>
              <Input id="job-location" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="ui-field">
              <Label htmlFor="job-hiring-manager">Hiring Manager</Label>
              <Input id="job-hiring-manager" value={hiringManager} onChange={(e) => setHiringManager(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="job-openings">Number of Openings</Label>
              <Input id="job-openings" type="number" min={1} value={numberOfOpenings} onChange={(e) => setNumberOfOpenings(e.target.value)} />
            </div>
          </div>
          {createMutation.isError ? <Alert tone="danger" title="Unable to create job" /> : null}
          <Button
            disabled={!title.trim() || !description.trim() || !mandatorySkills.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "Creating…" : "Create Job"}
          </Button>
        </Card>
      </section>
    </AccessGate>
  );
}

// ---------------------------------------------------------------------------------------------------
// Job Details / Candidate Analysis — Phase 7.
// ---------------------------------------------------------------------------------------------------

const RECOMMENDATION_LABELS: Record<RecruitmentAiRecommendation, string> = {
  RECOMMENDED_FOR_SHORTLIST: "Recommended",
  BELOW_MATCH_THRESHOLD: "Below Threshold",
  REVIEW_REQUIRED: "Review Required"
};
const DECISIONS: RecruitmentDecision[] = [
  "PENDING_REVIEW",
  "SHORTLISTED",
  "NOT_SELECTED",
  "INTERVIEW_SCHEDULED",
  "INTERVIEW_COMPLETED",
  "ON_HOLD",
  "HIRED"
];

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const api = useApi();
  const { client } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [recommendationFilter, setRecommendationFilter] = useState<RecruitmentAiRecommendation | "">("");
  const [batchId, setBatchId] = useState<string | null>(null);

  const jobQuery = useQuery({ queryKey: ["recruitment", "job", jobId], queryFn: () => api.getJob(jobId) });
  const candidatesQuery = useQuery({
    queryKey: ["recruitment", "candidates", jobId, page, search, recommendationFilter],
    queryFn: () =>
      api.listCandidates(jobId, {
        page,
        pageSize: 20,
        sortBy: "matchScore",
        ...(search ? { search } : {}),
        ...(recommendationFilter ? { aiRecommendation: recommendationFilter } : {})
      }),
    refetchInterval: 5000 // live-updates while a batch is still parsing/scoring in the background
  });
  const batchStatusQuery = useQuery({
    queryKey: ["recruitment", "batch", batchId],
    queryFn: () => api.batchStatus(batchId!),
    enabled: Boolean(batchId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && (data.status === "COMPLETED" || data.status === "COMPLETED_WITH_ERRORS" || data.status === "FAILED")
        ? false
        : 2000;
    }
  });

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => api.uploadResumeBatch(jobId, files),
    onSuccess: (result) => setBatchId(result.batchId)
  });

  const job = jobQuery.data;
  const candidates = candidatesQuery.data?.items ?? [];

  return (
    <AccessGate permission="recruitment.jobs.read">
      <section className="admin-page">
        <BackLink href="/dashboard/recruitment/jobs" label="Back to Job Openings" />
        {jobQuery.isLoading || !job ? (
          <Skeleton />
        ) : (
          <>
            <PageHeader
              title={job.title}
              eyebrow={job.jobCode}
              description={job.description.slice(0, 220)}
              action={
                <AccessGate permission="recruitment.resumes.upload">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,.docx"
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length) uploadMutation.mutate(files);
                      event.target.value = "";
                    }}
                  />
                  <Button onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending}>
                    {uploadMutation.isPending ? "Uploading…" : "Upload Resumes"}
                  </Button>
                </AccessGate>
              }
            />

            <div className="admin-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
              <SummaryCard title="Status" value={job.status} />
              <SummaryCard title="Total Resumes" value={job.totalResumes} />
              <SummaryCard title="AI-Recommended" value={job.aiRecommendedCount} />
              <SummaryCard title="Shortlisted" value={job.recruiterShortlistedCount} />
            </div>

            {batchId && batchStatusQuery.data ? (
              <Alert
                tone={batchStatusQuery.data.status === "FAILED" ? "danger" : "success"}
                title={`Batch: ${batchStatusQuery.data.totalFiles} total — ${batchStatusQuery.data.completed} completed, ${batchStatusQuery.data.processing} processing, ${batchStatusQuery.data.failed} failed, ${batchStatusQuery.data.queued} queued`}
              >
                {batchStatusQuery.data.failed > 0 ? (
                  <Button onClick={() => api.retryBatch(batchId).then(() => candidatesQuery.refetch())}>
                    Retry Failed
                  </Button>
                ) : null}
              </Alert>
            ) : null}

            <Card className="admin-toolbar" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <Input
                placeholder="Search candidate name, phone, email…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                style={{ minWidth: 240 }}
              />
              <select
                className="ui-input"
                value={recommendationFilter}
                onChange={(e) => {
                  setRecommendationFilter(e.target.value as RecruitmentAiRecommendation | "");
                  setPage(1);
                }}
              >
                <option value="">All AI recommendations</option>
                <option value="RECOMMENDED_FOR_SHORTLIST">Recommended</option>
                <option value="BELOW_MATCH_THRESHOLD">Below Threshold</option>
                <option value="REVIEW_REQUIRED">Review Required</option>
              </select>
              <AccessGate permission="recruitment.candidates.export">
                <Button
                  variant="ghost"
                  onClick={() => {
                    void client
                      .requestBlob(api.exportCandidatesUrl(jobId))
                      .then((blob) => {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `${job.jobCode}-candidates.csv`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 60_000);
                      });
                  }}
                >
                  Export CSV
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void client
                      .requestBlob(api.exportCandidatesXlsxUrl(jobId))
                      .then((blob) => {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `${job.jobCode}-candidates.xlsx`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 60_000);
                      });
                  }}
                >
                  Export XLSX
                </Button>
              </AccessGate>
            </Card>

            <AdvancedFilterPanel jobId={jobId} />

            {candidatesQuery.isLoading ? (
              <Skeleton />
            ) : candidates.length ? (
              <>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Candidate Name</th>
                        <th>Mobile Number</th>
                        <th>ATS Match Score</th>
                        <th>AI Recommendation</th>
                        <th>Selection Status</th>
                        <th>Resume ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((application) => (
                        <CandidateRow key={application.id} application={application} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="admin-pagination">
                  <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>Previous</Button>
                  <span>Page {page} of {Math.max(1, candidatesQuery.data?.totalPages ?? 1)}</span>
                  <Button
                    disabled={page >= (candidatesQuery.data?.totalPages ?? 1)}
                    onClick={() => setPage((x) => x + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState title="No candidates yet" description="Upload resumes to start matching candidates against this job." />
            )}
          </>
        )}
      </section>
    </AccessGate>
  );
}

function CandidateRow({ application }: Readonly<{ application: RecruitmentApplication }>) {
  const api = useApi();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const reviewMutation = useMutation({
    mutationFn: (decision: RecruitmentDecision) => api.reviewApplication(application.id, decision),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["recruitment", "candidates"] })
  });

  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={() => setExpanded((x) => !x)}>
        <td>{application.candidate.fullName ?? "Not Available"}</td>
        <td>{application.candidate.mobileNumber ?? "Not Available"}</td>
        <td>
          {application.evaluation?.evaluationStatus === "COMPLETED" && application.evaluation.matchScore !== null
            ? `${application.evaluation.matchScore}%`
            : application.resume.parsingStatus === "FAILED"
              ? "Parsing failed"
              : "Processing…"}
        </td>
        <td>{application.aiRecommendation ? RECOMMENDATION_LABELS[application.aiRecommendation] : "—"}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select
            className="ui-input"
            value={application.recruiterDecision}
            onChange={(e) => reviewMutation.mutate(e.target.value as RecruitmentDecision)}
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d}>{d.replace(/_/g, " ")}</option>
            ))}
          </select>
        </td>
        <td>{application.resume.resumeCode}</td>
      </tr>
      {expanded && application.evaluation ? (
        <tr>
          <td colSpan={6}>
            <Card style={{ margin: "8px 0" }}>
              <p><strong>Matched skills:</strong> {application.evaluation.matchedSkills?.join(", ") || "None"}</p>
              <p><strong>Missing skills:</strong> {application.evaluation.missingSkills?.join(", ") || "None"}</p>
              <p><strong>Explanation:</strong> {application.evaluation.explanation ?? "—"}</p>
              {application.evaluation.warnings?.length ? (
                <p><strong>Warnings:</strong> {application.evaluation.warnings.join("; ")}</p>
              ) : null}
            </Card>
          </td>
        </tr>
      ) : null}
    </>
  );
}
