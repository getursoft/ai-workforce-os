"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button, Card, Dialog, Input, Label } from "../../components/ui";
import { ApiError } from "../../lib/api-error";
import {
  createRecruitmentApi,
  type AdvancedCandidateQuery,
  type RecruitmentApplication,
  type RecruitmentDecision
} from "./recruitment-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createRecruitmentApi(client), [client]);
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

const DECISIONS: RecruitmentDecision[] = [
  "PENDING_REVIEW", "SHORTLISTED", "NOT_SELECTED", "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED", "ON_HOLD", "HIRED"
];

/** Sprint 7.16 Phase 10 — an additive advanced filter panel. Deliberately a separate section rather than
 * a rewrite of JobDetailPage's existing simple search+recommendation list (Phase 10: "Do not replace the
 * working UI") — this panel is opt-in: it only replaces the visible candidate table while the recruiter
 * has it expanded with at least one filter applied, backed by the SAME RecruitmentCandidateQueryService
 * the website's basic list, WhatsApp, iOS and the export engine all share. */
export function AdvancedFilterPanel({ jobId }: Readonly<{ jobId?: string }>) {
  const api = useApi();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [applied, setApplied] = useState<AdvancedCandidateQuery | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [bulkDecisionOpen, setBulkDecisionOpen] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<RecruitmentDecision>("SHORTLISTED");
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [detailApplication, setDetailApplication] = useState<RecruitmentApplication | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [showCallConfirm, setShowCallConfirm] = useState(false);

  // Draft form state — only becomes `applied` (and only then fires a request) on "Apply Filters".
  const [scoreGte, setScoreGte] = useState("");
  const [scoreGt, setScoreGt] = useState("");
  const [scoreLte, setScoreLte] = useState("");
  const [scoreLt, setScoreLt] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [region, setRegion] = useState("");
  const [minExp, setMinExp] = useState("");
  const [maxExp, setMaxExp] = useState("");
  const [allSkills, setAllSkills] = useState("");
  const [anySkills, setAnySkills] = useState("");
  const [willingToRelocate, setWillingToRelocate] = useState<"" | "yes" | "no">("");
  const [sortBy, setSortBy] = useState<NonNullable<AdvancedCandidateQuery["sortBy"]>>("score_desc");

  const presetsQuery = useQuery({ queryKey: ["recruitment", "filterPresets"], queryFn: () => api.listFilterPresets() });

  const buildQuery = (cursor?: string): AdvancedCandidateQuery => ({
    ...(jobId ? { jobId } : {}),
    ...(scoreGte ? { scoreGreaterThanOrEqual: Number(scoreGte) } : {}),
    ...(scoreGt ? { scoreGreaterThan: Number(scoreGt) } : {}),
    ...(scoreLte ? { scoreLessThanOrEqual: Number(scoreLte) } : {}),
    ...(scoreLt ? { scoreLessThan: Number(scoreLt) } : {}),
    ...(city ? { currentCity: splitList(city) } : {}),
    ...(state ? { currentState: splitList(state) } : {}),
    ...(region ? { region: splitList(region) } : {}),
    ...(minExp ? { minRelevantExperienceYears: Number(minExp) } : {}),
    ...(maxExp ? { maxRelevantExperienceYears: Number(maxExp) } : {}),
    ...(allSkills ? { allSkills: splitList(allSkills) } : {}),
    ...(anySkills ? { anySkills: splitList(anySkills) } : {}),
    ...(willingToRelocate ? { willingToRelocate: willingToRelocate === "yes" } : {}),
    sortBy,
    ...(cursor ? { cursor } : {})
  });

  const hasActiveFilters = Boolean(
    scoreGte || scoreGt || scoreLte || scoreLt || city || state || region || minExp || maxExp || allSkills || anySkills || willingToRelocate
  );

  const resultsQuery = useQuery({
    queryKey: ["recruitment", "advancedSearch", applied, pageIndex],
    queryFn: () => api.searchCandidates(applied ?? {}),
    enabled: Boolean(applied)
  });

  function apply() {
    setCursorStack([undefined]);
    setPageIndex(0);
    setSelected(new Set());
    setApplied(buildQuery());
  }

  function clear() {
    setScoreGte(""); setScoreGt(""); setScoreLte(""); setScoreLt("");
    setCity(""); setState(""); setRegion(""); setMinExp(""); setMaxExp("");
    setAllSkills(""); setAnySkills(""); setWillingToRelocate("");
    setSortBy("score_desc");
    setApplied(null);
    setSelected(new Set());
  }

  function goNext() {
    const next = resultsQuery.data?.nextCursor;
    if (!next) return;
    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), next]);
    setPageIndex((i) => i + 1);
    setApplied(buildQuery(next));
  }

  function goPrevious() {
    if (pageIndex === 0) return;
    const prevCursor = cursorStack[pageIndex - 1];
    setPageIndex((i) => i - 1);
    setApplied(buildQuery(prevCursor));
  }

  const savePresetMutation = useMutation({
    mutationFn: () => api.saveFilterPreset(presetName, applied ?? buildQuery()),
    onSuccess: () => {
      setSavePresetOpen(false);
      setPresetName("");
      void qc.invalidateQueries({ queryKey: ["recruitment", "filterPresets"] });
    }
  });

  const bulkReviewMutation = useMutation({
    mutationFn: async () => {
      for (const applicationId of selected) {
        await api.reviewApplication(applicationId, pendingDecision);
      }
    },
    onSuccess: () => {
      setBulkDecisionOpen(false);
      setSelected(new Set());
      void resultsQuery.refetch();
    }
  });

  async function startExport(scope: "FILTERED" | "CURRENT_JOB" | "ALL_AUTHORIZED" | "SELECTED", format: "CSV" | "XLSX") {
    setExportNotice("Preparing export…");
    const result = await api.requestExport({
      scope,
      format,
      ...(jobId ? { jobId } : {}),
      ...(scope === "FILTERED" ? { filters: applied ?? buildQuery() } : {}),
      ...(scope === "SELECTED" ? { selectedApplicationIds: Array.from(selected) } : {})
    });
    if (result.status === "COMPLETED" && result.downloadToken) {
      await downloadExport(result.exportJobId, result.downloadToken, result.rowCount);
      return;
    }
    // Sprint 7.17 (Phase 3) — large exports are now actually drained by a background worker rather than
    // sitting QUEUED forever, so poll for real instead of just telling the recruiter to "check back".
    setExportNotice(`Export queued (${result.rowCount} rows) — generating in the background…`);
    await pollExportUntilDone(result.exportJobId);
  }

  async function downloadExport(exportJobId: string, downloadToken: string, rowCount: number | null) {
    const { url } = await api.exportDownloadUrl(exportJobId, downloadToken);
    const link = document.createElement("a");
    link.href = url;
    link.click();
    setExportNotice(`Export ready — ${rowCount ?? "?"} rows.`);
    setTimeout(() => setExportNotice(null), 6000);
  }

  const EXPORT_POLL_INTERVAL_MS = 5000;
  const EXPORT_POLL_MAX_ATTEMPTS = 120; // ~10 minutes

  async function pollExportUntilDone(exportJobId: string, attempt = 0): Promise<void> {
    if (attempt >= EXPORT_POLL_MAX_ATTEMPTS) {
      setExportNotice("Still generating — this is taking longer than expected. The file will remain available once ready.");
      setTimeout(() => setExportNotice(null), 8000);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS));
    const status = await api.exportStatus(exportJobId);
    if (status.status === "COMPLETED" && status.downloadToken) {
      await downloadExport(exportJobId, status.downloadToken, status.rowCount);
      return;
    }
    if (status.status === "FAILED" || status.status === "EXPIRED" || status.status === "CANCELLED") {
      setExportNotice(`Export ${status.status.toLowerCase()}${status.errorMessage ? `: ${status.errorMessage}` : "."}`);
      setTimeout(() => setExportNotice(null), 8000);
      return;
    }
    return pollExportUntilDone(exportJobId, attempt + 1);
  }

  /// Sprint 7.17 (Phase 5): opening the detail view is the moment contact info (if the recruiter is
  /// authorized to see it — enforced server-side; `mobileNumber`/`email` simply arrive as null here
  /// otherwise) becomes visible, so that's when CONTACT_VIEWED is recorded — not deferred until a call.
  async function openCandidateDetail(application: RecruitmentApplication) {
    setDetailApplication(application);
    setCallError(null);
    if (application.candidate.mobileNumber) {
      await api
        .recordCallEvent(application.candidate.id, { status: "CONTACT_VIEWED", jobId: application.jobId, applicationId: application.id })
        .catch(() => undefined); // best-effort audit logging — never blocks the recruiter from viewing the detail
    }
  }

  /// The backend independently requires `recruitment.candidates.call` for this (not just `.contact`);
  /// the website never decides that for itself ahead of time — a 403 here IS the enforcement.
  async function callCandidate(application: RecruitmentApplication) {
    setShowCallConfirm(false);
    const phone = application.candidate.mobileNumber;
    if (!phone) return;
    try {
      await api.recordCallEvent(application.candidate.id, { status: "CALL_LINK_OPENED", jobId: application.jobId, applicationId: application.id });
      window.location.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
    } catch (error) {
      setCallError(
        error instanceof ApiError && error.kind === "authorization"
          ? "You don't have permission to call candidates."
          : "Couldn't start the call. Please try again."
      );
    }
  }

  async function cancelCall(application: RecruitmentApplication) {
    setShowCallConfirm(false);
    await api
      .recordCallEvent(application.candidate.id, { status: "CALL_CANCELLED", jobId: application.jobId, applicationId: application.id })
      .catch(() => undefined);
  }

  const items = resultsQuery.data?.items ?? [];

  return (
    <Card style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Advanced Filters</strong>
        <Button variant="ghost" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>

      {expanded ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div className="ui-field">
              <Label htmlFor="af-score-gte">Min ATS Score (≥)</Label>
              <Input id="af-score-gte" type="number" min={0} max={100} value={scoreGte} onChange={(e) => setScoreGte(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-score-gt">Min ATS Score (&gt;)</Label>
              <Input id="af-score-gt" type="number" min={0} max={100} value={scoreGt} onChange={(e) => setScoreGt(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-score-lte">Max ATS Score (≤)</Label>
              <Input id="af-score-lte" type="number" min={0} max={100} value={scoreLte} onChange={(e) => setScoreLte(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-score-lt">Max ATS Score (&lt;)</Label>
              <Input id="af-score-lt" type="number" min={0} max={100} value={scoreLt} onChange={(e) => setScoreLt(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-city">City (comma-separated)</Label>
              <Input id="af-city" placeholder="Noida, Pune" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-state">State (comma-separated)</Label>
              <Input id="af-state" value={state} onChange={(e) => setState(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-region">Region (comma-separated)</Label>
              <Input id="af-region" placeholder="Delhi NCR" value={region} onChange={(e) => setRegion(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-relocate">Willing to Relocate</Label>
              <select id="af-relocate" className="ui-input" value={willingToRelocate} onChange={(e) => setWillingToRelocate(e.target.value as "" | "yes" | "no")}>
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div className="ui-field">
              <Label htmlFor="af-min-exp">Min Relevant Experience (yrs)</Label>
              <Input id="af-min-exp" type="number" min={0} value={minExp} onChange={(e) => setMinExp(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-max-exp">Max Relevant Experience (yrs)</Label>
              <Input id="af-max-exp" type="number" min={0} value={maxExp} onChange={(e) => setMaxExp(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-all-skills">All of These Skills</Label>
              <Input id="af-all-skills" placeholder="Python, SQL" value={allSkills} onChange={(e) => setAllSkills(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-any-skills">Any of These Skills</Label>
              <Input id="af-any-skills" value={anySkills} onChange={(e) => setAnySkills(e.target.value)} />
            </div>
            <div className="ui-field">
              <Label htmlFor="af-sort">Sort By</Label>
              <select id="af-sort" className="ui-input" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                <option value="score_desc">Highest ATS Score</option>
                <option value="score_asc">Lowest ATS Score</option>
                <option value="experience_desc">Most Relevant Experience</option>
                <option value="experience_asc">Least Relevant Experience</option>
                <option value="uploadDate_desc">Latest Application</option>
                <option value="uploadDate_asc">Oldest Application</option>
                <option value="name_asc">Candidate Name</option>
              </select>
            </div>
          </div>

          {hasActiveFilters ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {scoreGte ? <Badge>Score ≥ {scoreGte}</Badge> : null}
              {scoreGt ? <Badge>Score &gt; {scoreGt}</Badge> : null}
              {scoreLte ? <Badge>Score ≤ {scoreLte}</Badge> : null}
              {scoreLt ? <Badge>Score &lt; {scoreLt}</Badge> : null}
              {splitList(city).map((c) => <Badge key={c}>City: {c}</Badge>)}
              {splitList(state).map((s) => <Badge key={s}>State: {s}</Badge>)}
              {splitList(region).map((r) => <Badge key={r}>Region: {r}</Badge>)}
              {willingToRelocate ? <Badge>Relocate: {willingToRelocate}</Badge> : null}
              {minExp ? <Badge>Exp ≥ {minExp}y</Badge> : null}
              {maxExp ? <Badge>Exp ≤ {maxExp}y</Badge> : null}
              {splitList(allSkills).map((s) => <Badge key={`all-${s}`}>Must have: {s}</Badge>)}
              {splitList(anySkills).map((s) => <Badge key={`any-${s}`}>Has: {s}</Badge>)}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={apply}>Apply Filters</Button>
            <Button variant="ghost" onClick={clear}>Clear Filters</Button>
            <Button variant="ghost" onClick={() => setSavePresetOpen(true)} disabled={!hasActiveFilters}>
              Save Filter Preset
            </Button>
            <Button variant="ghost" onClick={() => void startExport(applied ? "FILTERED" : jobId ? "CURRENT_JOB" : "ALL_AUTHORIZED", "CSV")}>
              Export Filtered (CSV)
            </Button>
            <Button variant="ghost" onClick={() => void startExport(applied ? "FILTERED" : jobId ? "CURRENT_JOB" : "ALL_AUTHORIZED", "XLSX")}>
              Export Filtered (XLSX)
            </Button>
            <Button variant="ghost" onClick={() => void startExport(jobId ? "CURRENT_JOB" : "ALL_AUTHORIZED", "CSV")}>
              Export All
            </Button>
            {selected.size > 0 ? (
              <>
                <Button variant="ghost" onClick={() => void startExport("SELECTED", "CSV")}>
                  Export Selected ({selected.size})
                </Button>
                <Button variant="ghost" onClick={() => setBulkDecisionOpen(true)}>
                  Update Status for Selected
                </Button>
              </>
            ) : null}
          </div>

          {exportNotice ? <Alert tone="success" title={exportNotice} /> : null}

          {presetsQuery.data?.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "var(--muted, #64748b)" }}>Saved presets:</span>
              {presetsQuery.data.map((preset) => (
                <Button
                  key={preset.id}
                  variant="ghost"
                  onClick={() => {
                    setApplied(preset.filters);
                    setCursorStack([undefined]);
                    setPageIndex(0);
                  }}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          ) : null}

          {applied ? (
            resultsQuery.isLoading ? (
              <p>Loading…</p>
            ) : items.length === 0 ? (
              <p>No candidates match these filters.</p>
            ) : (
              <>
                <p>{resultsQuery.data?.totalCount ?? 0} matching candidates</p>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Candidate Name</th>
                        <th>Location</th>
                        <th>Experience</th>
                        <th>ATS Score</th>
                        <th>AI Recommendation</th>
                        <th>Selection Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((application: RecruitmentApplication) => (
                        <tr key={application.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(application.id)}
                              onChange={(e) => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(application.id);
                                  else next.delete(application.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="ui-link-button"
                              style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}
                              onClick={() => void openCandidateDetail(application)}
                            >
                              {application.candidate.fullName ?? "Not Available"}
                            </button>
                          </td>
                          <td>{application.candidate.currentCity ?? "—"}</td>
                          <td>{application.resume.relevantExperienceYears ?? "—"} yrs</td>
                          <td>{application.evaluation?.matchScore !== undefined && application.evaluation?.matchScore !== null ? `${application.evaluation.matchScore}%` : "—"}</td>
                          <td>{application.aiRecommendation ?? "—"}</td>
                          <td>{application.recruiterDecision.replace(/_/g, " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="admin-pagination">
                  <Button disabled={pageIndex === 0} onClick={goPrevious}>Previous</Button>
                  <span>Page {pageIndex + 1}</span>
                  <Button disabled={!resultsQuery.data?.nextCursor} onClick={goNext}>Next</Button>
                </div>
              </>
            )
          ) : null}
        </>
      ) : null}

      <Dialog
        open={savePresetOpen}
        title="Save Filter Preset"
        onConfirm={() => savePresetMutation.mutate()}
        onCancel={() => setSavePresetOpen(false)}
        confirmLabel="Save"
      >
        <div className="ui-field">
          <Label htmlFor="preset-name">Preset name</Label>
          <Input id="preset-name" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
        </div>
      </Dialog>

      <Dialog
        open={bulkDecisionOpen}
        title={`Update ${selected.size} candidate(s)`}
        description="This changes the human review status for every selected candidate. This cannot be undone automatically."
        onConfirm={() => bulkReviewMutation.mutate()}
        onCancel={() => setBulkDecisionOpen(false)}
        confirmLabel="Update"
        destructive
      >
        <div className="ui-field">
          <Label htmlFor="bulk-decision">New status</Label>
          <select
            id="bulk-decision"
            className="ui-input"
            value={pendingDecision}
            onChange={(e) => setPendingDecision(e.target.value as RecruitmentDecision)}
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d}>{d.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
      </Dialog>

      {/* Sprint 7.17 (Phase 5) — candidate detail + manual tap-to-call. mobileNumber/email arrive as
          null unless the recruiter holds recruitment.candidates.contact (enforced server-side, never a
          client-side-only mask); the call action is independently gated by recruitment.candidates.call,
          enforced the same way. A tel: link only opens the OS's own calling UI — this is never proof a
          call was placed or connected. */}
      <Dialog
        open={detailApplication !== null}
        title={detailApplication?.candidate.fullName ?? "Candidate"}
        showActions={false}
        onConfirm={() => {}}
        onCancel={() => setDetailApplication(null)}
      >
        {detailApplication ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div><strong>ATS Score:</strong> {detailApplication.evaluation?.matchScore != null ? `${detailApplication.evaluation.matchScore}%` : "Pending"}</div>
            <div><strong>Location:</strong> {detailApplication.candidate.currentCity ?? "Not Available"}</div>
            <div><strong>Experience:</strong> {detailApplication.resume.relevantExperienceYears ?? "—"} yrs</div>
            <div><strong>Decision:</strong> {detailApplication.recruiterDecision.replace(/_/g, " ")}</div>
            <div>
              <strong>Phone:</strong>{" "}
              {detailApplication.candidate.mobileNumber ?? <span style={{ color: "var(--muted, #64748b)" }}>Hidden — no contact permission, or not on file</span>}
            </div>
            <div><strong>Email:</strong> {detailApplication.candidate.email ?? "Not Available"}</div>

            {callError ? <Alert tone="danger" title={callError} /> : null}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {detailApplication.candidate.mobileNumber ? (
                <Button onClick={() => setShowCallConfirm(true)}>Call {detailApplication.candidate.mobileNumber}</Button>
              ) : null}
              <Button variant="ghost" onClick={() => setDetailApplication(null)}>Close</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={showCallConfirm && detailApplication !== null}
        title={`Call ${detailApplication?.candidate.fullName ?? "this candidate"}?`}
        description="This opens your device's own calling app with the candidate's number. It does not place the call for you, and does not track whether the call connects."
        confirmLabel="Call"
        onConfirm={() => { if (detailApplication) void callCandidate(detailApplication); }}
        onCancel={() => { if (detailApplication) void cancelCall(detailApplication); }}
      />
    </Card>
  );
}
