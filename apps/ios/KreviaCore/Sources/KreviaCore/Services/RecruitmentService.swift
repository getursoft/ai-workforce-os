import Foundation

/// Maps 1:1 to apps/api/src/recruitment — job CRUD, AI-assisted JD-parsing suggestions, bulk resume
/// upload, batch status polling, candidate listing, and human review. Full parity with the website: job
/// creation and resume upload are implemented here, not deferred.
public struct RecruitmentService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func listJobs(page: Int = 1) async throws -> RecruitmentJobPage {
        try await client.request(.get, "/recruitment/jobs", query: [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: "20")
        ])
    }

    public func getJob(_ id: String) async throws -> RecruitmentJob {
        try await client.request(.get, "/recruitment/jobs/\(id)")
    }

    public func createJob(
        title: String,
        description: String,
        department: String?,
        location: String?,
        minExperienceYears: Int?,
        maxExperienceYears: Int?,
        requiredCriteria: RecruitmentRequiredCriteria,
        hiringManager: String?,
        numberOfOpenings: Int
    ) async throws -> RecruitmentJob {
        try await client.request(.post, "/recruitment/jobs", body: CreateJobRequest(
            title: title,
            description: description,
            department: department,
            location: location,
            minExperienceYears: minExperienceYears,
            maxExperienceYears: maxExperienceYears,
            requiredCriteria: requiredCriteria,
            scoringConfig: .default,
            hiringManager: hiringManager,
            numberOfOpenings: numberOfOpenings
        ))
    }

    /// Returns AI-suggested criteria the recruiter must still confirm/edit before `createJob` ever
    /// persists anything — never writes to the database itself (Phase 2's "recruiter must confirm or
    /// edit the generated requirements").
    public func parseJobDescription(_ text: String) async throws -> RecruitmentSuggestedCriteria {
        try await client.request(.post, "/recruitment/jobs/parse-description", body: ParseJdRequest(text: text))
    }

    public func uploadResumeBatch(jobId: String, files: [MultipartFile]) async throws -> RecruitmentUploadBatchResult {
        try await client.uploadMultipart("/recruitment/jobs/\(jobId)/resumes/batch", files: files)
    }

    public func batchStatus(_ batchId: String) async throws -> RecruitmentBatchStatus {
        try await client.request(.get, "/recruitment/batches/\(batchId)")
    }

    public func listCandidates(jobId: String, page: Int = 1) async throws -> RecruitmentApplicationPage {
        try await client.request(.get, "/recruitment/jobs/\(jobId)/candidates", query: [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: "20"),
            URLQueryItem(name: "sortBy", value: "matchScore")
        ])
    }

    public func reviewApplication(_ applicationId: String, decision: String) async throws -> RecruitmentApplication {
        try await client.request(.post, "/recruitment/applications/\(applicationId)/review", body: ReviewRequest(recruiterDecision: decision))
    }

    /// Sprint 7.16 (Phase 6/12) — the shared advanced-filter search. Posts the exact same
    /// RecruitmentCandidateQuery shape the website and WhatsApp build, against the exact same endpoint
    /// (POST /recruitment/candidates/search), so identical filters return identical results across all
    /// three surfaces by construction — no filtering/scoring logic is duplicated here.
    public func searchCandidates(_ query: RecruitmentCandidateQuery) async throws -> RecruitmentCandidateQueryResult {
        try await client.request(.post, "/recruitment/candidates/search", body: query)
    }

    /// Sprint 7.17 (Phase 2) — same export engine the website uses; iOS requests a file and gets back
    /// either a ready download token (small exports complete synchronously) or a QUEUED status.
    public func requestExport(
        scope: String, format: String, jobId: String? = nil,
        filters: RecruitmentCandidateQuery? = nil, selectedApplicationIds: [String]? = nil
    ) async throws -> RecruitmentExportRequestResult {
        try await client.request(.post, "/recruitment/candidates/export", body: RecruitmentExportRequest(
            scope: scope, format: format, jobId: jobId, filters: filters, selectedApplicationIds: selectedApplicationIds
        ))
    }

    public func exportStatus(_ exportJobId: String) async throws -> RecruitmentExportStatus {
        try await client.request(.get, "/recruitment/candidates/export/\(exportJobId)")
    }

    /// Sprint 7.17 (Phase 5) — `status` must be one of the client-reportable calling-audit events
    /// (CONTACT_VIEWED, CALL_ACTION_REQUESTED, CALL_LINK_OPENED, CALL_CANCELLED); the server rejects
    /// anything else, since provider-attested states (CALL_CONNECTED, etc.) can never come from a client.
    public func recordCallEvent(
        candidateId: String, status: String, jobId: String?, applicationId: String?, platform: String = "IOS"
    ) async throws {
        struct Body: Encodable {
            let status: String; let jobId: String?; let applicationId: String?; let channel: String; let platform: String
        }
        struct CallLogResponse: Decodable { let id: String }
        let _: CallLogResponse = try await client.request(
            .post, "/recruitment/candidates/\(candidateId)/call-log",
            body: Body(status: status, jobId: jobId, applicationId: applicationId, channel: "MANUAL_CLICK_TO_CALL", platform: platform)
        )
    }

    public func exportDownloadURL(exportJobId: String, token: String) async throws -> URL {
        let result: DownloadURLResponse = try await client.request(
            .get, "/recruitment/candidates/export/\(exportJobId)/download",
            query: [URLQueryItem(name: "token", value: token)]
        )
        guard let url = URL(string: result.url) else { throw APIError.decoding("Invalid download URL") }
        return url
    }
}

private struct DownloadURLResponse: Codable {
    let url: String
}

private struct ReviewRequest: Encodable {
    let recruiterDecision: String
}

private struct ParseJdRequest: Encodable {
    let text: String
}

private struct CreateJobRequest: Encodable {
    let title: String
    let description: String
    let department: String?
    let location: String?
    let minExperienceYears: Int?
    let maxExperienceYears: Int?
    let requiredCriteria: RecruitmentRequiredCriteria
    let scoringConfig: RecruitmentScoringConfig
    let hiringManager: String?
    let numberOfOpenings: Int
}
