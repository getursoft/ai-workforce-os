import Foundation

/// Maps 1:1 to apps/api/src/leads/lead.controller.ts (`/api/v1/leads`).
public struct LeadService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func summary() async throws -> LeadSummary {
        try await client.request(.get, "/leads/summary")
    }

    public func list(_ query: ListLeadsQuery) async throws -> LeadPage {
        try await client.request(.get, "/leads", query: query.queryItems)
    }

    public func get(_ id: String) async throws -> Lead {
        try await client.request(.get, "/leads/\(id)")
    }

    public func getByReference(_ referenceId: String) async throws -> Lead {
        let encoded = referenceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? referenceId
        return try await client.request(.get, "/leads/reference/\(encoded)")
    }

    public func activity(_ id: String) async throws -> [LeadActivity] {
        try await client.request(.get, "/leads/\(id)/activity")
    }

    public func create(_ input: CreateLeadRequest) async throws -> Lead {
        try await client.request(.post, "/leads", body: input)
    }

    public func update(_ id: String, _ input: UpdateLeadRequest) async throws -> Lead {
        try await client.request(.patch, "/leads/\(id)", body: input)
    }

    public func addNote(_ id: String, note: String) async throws {
        try await client.requestVoid(.post, "/leads/\(id)/notes", body: AddLeadNoteRequest(note: note))
    }

    public func assign(_ id: String, assignedToUserId: String?) async throws -> Lead {
        try await client.request(.post, "/leads/\(id)/assign", body: AssignLeadRequest(assignedToUserId: assignedToUserId))
    }
}
