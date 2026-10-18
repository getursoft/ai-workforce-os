import Foundation

@MainActor
public final class ConversationDetailViewModel: ObservableObject {
    @Published public private(set) var interaction: InteractionSummary?
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?

    private let conversationService: ConversationService
    private let interactionId: String

    public init(interactionId: String, conversationService: ConversationService) {
        self.interactionId = interactionId
        self.conversationService = conversationService
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            interaction = try await conversationService.detail(interactionId)
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }
}
