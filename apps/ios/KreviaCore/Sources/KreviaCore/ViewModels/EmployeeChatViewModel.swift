import Foundation

@MainActor
public final class EmployeeChatViewModel: ObservableObject {
    @Published public private(set) var messages: [ConversationChatMessage] = []
    @Published public private(set) var isSending = false
    @Published public var errorMessage: String?
    @Published public var draft = ""

    private let agentService: AgentService
    private let pluginInstallationId: String
    private var conversationId: String?

    public init(employeeId: String, agentService: AgentService) {
        self.pluginInstallationId = employeeId
        self.agentService = agentService
    }

    public var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    public func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        errorMessage = nil
        let userMessage = ConversationChatMessage(
            id: UUID().uuidString, role: .user, content: text, createdAt: Date()
        )
        messages.append(userMessage)
        isSending = true
        do {
            let result = try await agentService.run(
                pluginInstallationId: pluginInstallationId,
                conversationId: conversationId,
                message: text
            )
            conversationId = result.conversationId
            if !result.response.isEmpty {
                messages.append(ConversationChatMessage(
                    id: result.executionId ?? UUID().uuidString,
                    role: .assistant, content: result.response, createdAt: Date()
                ))
            }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isSending = false
    }
}
