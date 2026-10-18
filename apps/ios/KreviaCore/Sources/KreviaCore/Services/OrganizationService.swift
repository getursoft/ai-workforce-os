import Foundation

/// Maps 1:1 to apps/api/src/identity/presentation/http/organizations.controller.ts (`/organizations`).
public struct OrganizationService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func me() async throws -> OrganizationSummary {
        let envelope: OrganizationEnvelope = try await client.request(.get, "/organizations/me")
        return envelope.organization
    }

    public func meSettings() async throws -> OrganizationSettingsDetail {
        let envelope: OrganizationSettingsEnvelope = try await client.request(.get, "/organizations/me/settings")
        return envelope.organizationSetting
    }

    public func updateMe(name: String) async throws -> OrganizationSummary {
        let envelope: OrganizationEnvelope = try await client.request(.patch, "/organizations/me", body: UpdateOrganizationRequest(name: name))
        return envelope.organization
    }

    public func updateMeSettings(timezone: String?, currency: String?, locale: String?) async throws -> OrganizationSettingsDetail {
        let envelope: OrganizationSettingsEnvelope = try await client.request(
            .patch, "/organizations/me/settings",
            body: UpdateOrganizationSettingsRequest(timezone: timezone, currency: currency, locale: locale)
        )
        return envelope.organizationSetting
    }
}

private struct UpdateOrganizationRequest: Encodable {
    let name: String
}

private struct UpdateOrganizationSettingsRequest: Encodable {
    let timezone: String?
    let currency: String?
    let locale: String?
}
