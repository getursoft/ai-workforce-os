import Foundation

/// Maps 1:1 to apps/api/src/agents/agent.controller.ts (`POST /agents/run`) — the same endpoint the
/// dashboard's own `EmployeeChatPage` uses, not the `/plugins/:id/chat` dev stub.
public struct AgentRunResult: Codable, Equatable, Sendable {
    public let conversationId: String
    public let response: String
    public let executionId: String?
    public let status: String?
}

public enum ConversationMessageRole: String, Codable, Equatable, Sendable {
    case system = "SYSTEM"
    case user = "USER"
    case assistant = "ASSISTANT"
    case tool = "TOOL"
}

/// Maps to the raw `ConversationMessage` Prisma rows `GET /conversations/:id/messages` returns.
public struct ConversationChatMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let role: ConversationMessageRole
    public let content: String
    public let createdAt: Date
}
