import Foundation

@MainActor
public final class ManualLeadViewModel: ObservableObject {
    @Published public var name: String = ""
    @Published public var phone: String = ""
    @Published public var email: String = ""
    @Published public var requirement: String = ""
    @Published public var priority: LeadPriority = .medium
    @Published public private(set) var isSaving: Bool = false
    @Published public var errorMessage: String?
    @Published public private(set) var createdLead: Lead?

    private let leadService: LeadService

    public init(leadService: LeadService) {
        self.leadService = leadService
    }

    public var canSubmit: Bool {
        (!name.trimmingCharacters(in: .whitespaces).isEmpty
            || !phone.trimmingCharacters(in: .whitespaces).isEmpty
            || !email.trimmingCharacters(in: .whitespaces).isEmpty)
            && !isSaving
    }

    public func submit() async {
        guard canSubmit else { return }
        isSaving = true
        errorMessage = nil
        do {
            let input = CreateLeadRequest(
                name: name.isEmpty ? nil : name,
                phone: phone.isEmpty ? nil : phone,
                email: email.isEmpty ? nil : email,
                requirement: requirement.isEmpty ? nil : requirement,
                priority: priority
            )
            createdLead = try await leadService.create(input)
        } catch let error as APIError where error.isForbidden {
            // RBAC: the signed-in user lacks `leads.create` — surface a clear, non-technical message
            // rather than a generic failure.
            errorMessage = "You don't have permission to create leads. Ask an admin for access."
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isSaving = false
    }
}
