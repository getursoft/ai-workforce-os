import Foundation

/// Maps 1:1 to apps/api/src/identity/application/models/organization-result.ts's
/// `PublicOrganizationSummary` / `PublicOrganizationSetting`.
public struct OrganizationSummary: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let status: String
}

public struct OrganizationSettingsDetail: Codable, Equatable, Sendable {
    public let id: String
    public let organizationId: String
    public let timezone: String
    public let currency: String
    public let locale: String
}

struct OrganizationEnvelope: Codable {
    let organization: OrganizationSummary
}

struct OrganizationSettingsEnvelope: Codable {
    let organizationSetting: OrganizationSettingsDetail
}
