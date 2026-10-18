import Foundation

/// Maps 1:1 to apps/api/src/plugins/plugin.controller.ts (`/plugins`). The AI Employee catalog and
/// install flow — `available()` lists every discoverable plugin with an `installed` flag; `install()`
/// is the one path every AI Employee installation goes through, regardless of which employee.
public struct PluginService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func available() async throws -> PluginCatalogPage {
        try await client.request(.get, "/plugins/available")
    }

    public func install(pluginId: String) async throws -> PluginInstallResult {
        try await client.request(.post, "/plugins/install", body: InstallPluginRequest(pluginId: pluginId, enable: true))
    }

    public func uninstall(_ id: String) async throws {
        try await client.requestVoid(.delete, "/plugins/\(id)")
    }
}

private struct InstallPluginRequest: Encodable {
    let pluginId: String
    let enable: Bool
}
