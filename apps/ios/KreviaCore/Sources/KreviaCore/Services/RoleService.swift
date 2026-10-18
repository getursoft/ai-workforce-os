import Foundation

/// Maps 1:1 to apps/api/src/identity/presentation/http/management.controller.ts (`/roles`).
public struct RoleService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func list() async throws -> [OrgRole] {
        try await client.request(.get, "/roles")
    }

    public func create(name: String, description: String?) async throws -> OrgRole {
        try await client.request(.post, "/roles", body: CreateRoleRequest(name: name, description: description))
    }
}

private struct CreateRoleRequest: Encodable {
    let name: String
    let description: String?
}
