import Foundation

@MainActor
public final class RecruitmentJobDetailViewModel: ObservableObject {
    @Published public private(set) var job: RecruitmentJob?
    @Published public private(set) var candidates: [RecruitmentApplication] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var isReviewing: String?
    @Published public private(set) var isUploading = false
    @Published public var uploadError: String?
    @Published public private(set) var batchStatus: RecruitmentBatchStatus?

    private let service: RecruitmentService
    private let jobId: String
    private var pollTask: Task<Void, Never>?

    public init(jobId: String, service: RecruitmentService) {
        self.jobId = jobId
        self.service = service
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            async let jobResult = service.getJob(jobId)
            async let candidatesResult = service.listCandidates(jobId: jobId)
            let (loadedJob, page) = try await (jobResult, candidatesResult)
            job = loadedJob
            candidates = page.items
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func review(_ application: RecruitmentApplication, decision: String) async {
        isReviewing = application.id
        do {
            let updated = try await service.reviewApplication(application.id, decision: decision)
            if let index = candidates.firstIndex(where: { $0.id == application.id }) {
                candidates[index] = updated
            }
        } catch {
            // Silent — the candidate list already shows the prior decision; pull-to-refresh can retry.
        }
        isReviewing = nil
    }

    /// Uploads the given files as one batch, then polls batch status (and refreshes the candidate list
    /// once results start landing) until processing reaches a terminal state — same shape as the
    /// website's live-polling behavior, just driven from a Task instead of a query-library refetch.
    public func uploadResumes(_ files: [MultipartFile]) async {
        guard !files.isEmpty else { return }
        isUploading = true
        uploadError = nil
        do {
            let result = try await service.uploadResumeBatch(jobId: jobId, files: files)
            isUploading = false
            startPolling(batchId: result.batchId)
        } catch let error as APIError {
            uploadError = error.userMessage
            isUploading = false
        } catch {
            uploadError = "Couldn't upload these resumes. Please try again."
            isUploading = false
        }
    }

    private func startPolling(batchId: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            for _ in 0..<60 {
                if Task.isCancelled { return }
                guard let status = try? await self.service.batchStatus(batchId) else { return }
                self.batchStatus = status
                if status.status != "QUEUED" && status.status != "PROCESSING" {
                    await self.load()
                    return
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await self.load() // live-updates the candidate list while still processing, like the website
            }
        }
    }

    deinit {
        pollTask?.cancel()
    }
}
