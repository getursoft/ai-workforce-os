import Foundation

/// Maps 1:1 to apps/api/src/identity/presentation/http/management.controller.ts (`/roles`) — raw
/// Prisma `Role` rows with their permission grants. `_count` is only present on the list response
/// (`listRoles`'s `include`), not on `createRole`'s — optional so both decode cleanly.
public struct OrgRole: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let isSystem: Bool
    public let permissions: [RolePermissionGrant]
    public let count: RoleUserCount?

    enum CodingKeys: String, CodingKey {
        case id, name, description, isSystem, permissions
        case count = "_count"
    }
}

public struct RoleUserCount: Codable, Equatable, Sendable {
    public let users: Int
}

public struct RolePermissionGrant: Codable, Equatable, Sendable {
    public let permission: PermissionSummary
}

public struct PermissionSummary: Codable, Equatable, Sendable {
    public let id: String
    public let key: String
    public let description: String?
}
