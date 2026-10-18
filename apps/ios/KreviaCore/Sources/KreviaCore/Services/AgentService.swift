import Foundation

/// Maps 1:1 to apps/api/src/agents/agent.controller.ts — the production "talk to an AI Employee"
/// path (same one the dashboard's chat page calls), not `/plugins/:id/chat`.
public struct AgentService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func run(pluginInstallationId: String, conversationId: String?, message: String) async throws -> AgentRunResult {
        try await client.request(.post, "/agents/run", body: AgentRunRequest(
            pluginInstallationId: pluginInstallationId,
            conversationId: conversationId,
            message: message
        ))
    }

    public func messages(conversationId: String) async throws -> [ConversationChatMessage] {
        try await client.request(.get, "/conversations/\(conversationId)/messages")
    }
}

private struct AgentRunRequest: Encodable {
    let pluginInstallationId: String
    let conversationId: String?
    let message: String
}
