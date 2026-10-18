import Foundation

@MainActor
public final class RecruitmentJobsViewModel: ObservableObject {
    @Published public private(set) var jobs: [RecruitmentJob] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?

    private let service: RecruitmentService

    public init(service: RecruitmentService) {
        self.service = service
    }

    public var isEmpty: Bool { jobs.isEmpty && !isLoading && errorMessage == nil }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            jobs = try await service.listJobs().items
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func refresh() async { await load() }
}
