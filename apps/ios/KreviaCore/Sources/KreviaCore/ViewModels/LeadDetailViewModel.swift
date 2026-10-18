import Foundation

@MainActor
public final class LeadDetailViewModel: ObservableObject {
    @Published public private(set) var lead: Lead?
    @Published public private(set) var activity: [LeadActivity] = []
    @Published public private(set) var isLoading: Bool = false
    @Published public var errorMessage: String?
    @Published public private(set) var isMutating: Bool = false
    @Published public var noteText: String = ""

    private let leadService: LeadService
    private let leadId: String

    public init(leadId: String, leadService: LeadService) {
        self.leadId = leadId
        self.leadService = leadService
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        async let leadFetch = leadService.get(leadId)
        async let activityFetch = leadService.activity(leadId)
        do {
            let (loadedLead, loadedActivity) = try await (leadFetch, activityFetch)
            lead = loadedLead
            activity = loadedActivity.sorted { $0.createdAt > $1.createdAt }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func updateStatus(_ status: LeadStatus) async {
        await mutate { leadService in
            try await leadService.update(self.leadId, UpdateLeadRequest(status: status))
        }
    }

    public func assign(to userId: String?) async {
        await mutate { leadService in
            try await leadService.assign(self.leadId, assignedToUserId: userId)
        }
    }

    public func addNote() async {
        let trimmed = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isMutating = true
        errorMessage = nil
        do {
            try await leadService.addNote(leadId, note: trimmed)
            noteText = ""
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isMutating = false
    }

    private func mutate(_ operation: @escaping (LeadService) async throws -> Lead) async {
        isMutating = true
        errorMessage = nil
        do {
            let updated = try await operation(leadService)
            lead = updated
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isMutating = false
    }
}
