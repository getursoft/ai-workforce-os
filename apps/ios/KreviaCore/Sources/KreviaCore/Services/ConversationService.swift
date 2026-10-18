import Foundation

/// Maps 1:1 to apps/api/src/interaction/interaction.controller.ts (`/interactions`). Requires
/// `agents.conversations.read`, granted to the Owner role by default.
public struct ConversationService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func list(page: Int = 1, pageSize: Int = 20, status: InteractionStatus? = nil) async throws -> InteractionPage {
        var query = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if let status { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        return try await client.request(.get, "/interactions", query: query)
    }

    public func detail(_ id: String) async throws -> InteractionSummary {
        try await client.request(.get, "/interactions/\(id)")
    }
}
