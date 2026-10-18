import Foundation

/// Sprint 7.17 (Phase 2) — the iOS advanced filter screen's state and the SAME shared
/// /recruitment/candidates/search endpoint the website and WhatsApp use. No filtering or scoring logic
/// is duplicated here; this view model only builds a RecruitmentCandidateQuery and renders what the
/// server returns, so identical filters produce identical results across every client by construction.
@MainActor
public final class RecruitmentCandidateFilterViewModel: ObservableObject {
    // Draft filter fields — bound directly to the filter form.
    @Published public var scoreMin: String = ""
    @Published public var scoreMax: String = ""
    @Published public var currentCity: String = ""
    @Published public var currentState: String = ""
    @Published public var region: String = ""
    @Published public var preferredWorkLocation: String = ""
    @Published public var minExperience: String = ""
    @Published public var maxExperience: String = ""
    @Published public var requiredSkills: String = ""
    @Published public var searchText: String = ""
    @Published public var sortBy: String = "score_desc"

    @Published public private(set) var items: [RecruitmentApplication] = []
    @Published public private(set) var totalCount: Int = 0
    @Published public private(set) var isLoading = false
    @Published public private(set) var isLoadingMore = false
    @Published public private(set) var hasMore = false
    @Published public var errorMessage: String?
    @Published public var selectedIds: Set<String> = []
    @Published public private(set) var exportNotice: String?
    @Published public private(set) var queuedExportJobId: String?

    public let sortOptions: [(label: String, value: String)] = [
        ("Highest ATS Score", "score_desc"),
        ("Lowest ATS Score", "score_asc"),
        ("Most Relevant Experience", "experience_desc"),
        ("Latest Application", "uploadDate_desc"),
        ("Candidate Name", "name_asc")
    ]

    private let service: RecruitmentService
    private let jobId: String?
    private var nextCursor: String?
    private var appliedQuery: RecruitmentCandidateQuery?

    public init(service: RecruitmentService, jobId: String? = nil) {
        self.service = service
        self.jobId = jobId
    }

    private func splitList(_ raw: String) -> [String]? {
        let values = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return values.isEmpty ? nil : values
    }

    private func buildQuery(cursor: String? = nil) -> RecruitmentCandidateQuery {
        RecruitmentCandidateQuery(
            jobId: jobId,
            scoreGreaterThanOrEqual: Double(scoreMin),
            scoreLessThanOrEqual: Double(scoreMax),
            currentCity: splitList(currentCity),
            currentState: splitList(currentState),
            region: splitList(region),
            minRelevantExperienceYears: Int(minExperience),
            maxRelevantExperienceYears: Int(maxExperience),
            anySkills: splitList(requiredSkills),
            search: searchText.trimmingCharacters(in: .whitespaces).isEmpty ? nil : searchText,
            sortBy: sortBy,
            cursor: cursor,
            limit: 20
        )
    }

    public var hasActiveFilters: Bool {
        !scoreMin.isEmpty || !scoreMax.isEmpty || !currentCity.isEmpty || !currentState.isEmpty
            || !region.isEmpty || !minExperience.isEmpty || !maxExperience.isEmpty || !requiredSkills.isEmpty
            || !searchText.isEmpty
    }

    public func applyFilters() async {
        isLoading = true
        errorMessage = nil
        selectedIds = []
        let query = buildQuery()
        appliedQuery = query
        do {
            let result = try await service.searchCandidates(query)
            items = result.items
            totalCount = result.totalCount
            nextCursor = result.nextCursor
            hasMore = result.nextCursor != nil
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func loadMore() async {
        guard let cursor = nextCursor, let base = appliedQuery, !isLoadingMore else { return }
        isLoadingMore = true
        do {
            let result = try await service.searchCandidates(buildQueryReusing(base, cursor: cursor))
            items.append(contentsOf: result.items)
            nextCursor = result.nextCursor
            hasMore = result.nextCursor != nil
        } catch {
            // Non-fatal — the recruiter can retry by scrolling again; the existing list stays intact.
        }
        isLoadingMore = false
    }

    private func buildQueryReusing(_ base: RecruitmentCandidateQuery, cursor: String) -> RecruitmentCandidateQuery {
        var next = base
        next.cursor = cursor
        return next
    }

    public func clearFilters() {
        scoreMin = ""; scoreMax = ""; currentCity = ""; currentState = ""; region = ""
        preferredWorkLocation = ""; minExperience = ""; maxExperience = ""; requiredSkills = ""
        searchText = ""; sortBy = "score_desc"
        items = []; totalCount = 0; nextCursor = nil; appliedQuery = nil; selectedIds = []
    }

    public func toggleSelection(_ applicationId: String) {
        if selectedIds.contains(applicationId) { selectedIds.remove(applicationId) } else { selectedIds.insert(applicationId) }
    }

    /// Exports exactly what's currently shown (the applied filters) or, when any rows are selected,
    /// only those rows — mirrors the website's "Export Filtered" / "Export Selected" distinction.
    public func exportResults(format: String = "CSV") async -> URL? {
        exportNotice = "Preparing export…"
        do {
            let result: RecruitmentExportRequestResult
            if !selectedIds.isEmpty {
                result = try await service.requestExport(scope: "SELECTED", format: format, selectedApplicationIds: Array(selectedIds))
            } else {
                result = try await service.requestExport(
                    scope: jobId != nil ? "CURRENT_JOB" : "FILTERED", format: format,
                    jobId: jobId, filters: appliedQuery ?? buildQuery()
                )
            }
            if result.status == "COMPLETED", let token = result.downloadToken {
                let url = try await service.exportDownloadURL(exportJobId: result.exportJobId, token: token)
                exportNotice = "Export ready — \(result.rowCount) rows."
                return url
            }
            exportNotice = "Export queued (\(result.rowCount) rows) — generating in the background…"
            queuedExportJobId = result.exportJobId
            return nil
        } catch let error as APIError {
            exportNotice = error.userMessage
            return nil
        } catch {
            exportNotice = "Export failed. Please try again."
            return nil
        }
    }

    /// Sprint 7.17 (Phase 3) — large exports are now actually drained by a background worker rather than
    /// sitting QUEUED forever, so the caller can poll for a real result instead of just waiting on
    /// `exportResults()`'s immediate "queued" notice. Call this after `exportResults()` returns nil and
    /// `queuedExportJobId` is set. Mirrors the website's own poll loop (recruitment-advanced-filters.tsx).
    public func pollExportUntilDone(maxAttempts: Int = 120, intervalSeconds: UInt64 = 5) async -> URL? {
        guard let exportJobId = queuedExportJobId else { return nil }
        for _ in 0..<maxAttempts {
            try? await Task.sleep(nanoseconds: intervalSeconds * 1_000_000_000)
            guard let status = try? await service.exportStatus(exportJobId) else { continue }
            if status.status == "COMPLETED", let token = status.downloadToken {
                do {
                    let url = try await service.exportDownloadURL(exportJobId: exportJobId, token: token)
                    exportNotice = "Export ready — \(status.rowCount ?? 0) rows."
                    queuedExportJobId = nil
                    return url
                } catch {
                    exportNotice = "Export failed. Please try again."
                    queuedExportJobId = nil
                    return nil
                }
            }
            if status.status == "FAILED" || status.status == "EXPIRED" || status.status == "CANCELLED" {
                exportNotice = "Export \(status.status.lowercased())\(status.errorMessage.map { ": \($0)" } ?? ".")"
                queuedExportJobId = nil
                return nil
            }
        }
        exportNotice = "Still generating — this is taking longer than expected."
        return nil
    }
}
