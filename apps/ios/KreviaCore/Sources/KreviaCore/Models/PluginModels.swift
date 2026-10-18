import Foundation

/// Maps 1:1 to apps/api/src/plugins/plugin.controller.ts's `publicManifest()` plus the `installed`
/// flag `PluginService.available()` adds — the AI Employee catalog, not yet-installed instances.
public struct PluginCatalogItem: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let displayName: String
    public let description: String?
    public let installed: Bool
}

public struct PluginCatalogPage: Codable, Equatable, Sendable {
    public let items: [PluginCatalogItem]
}

public struct PluginInstallResult: Codable, Equatable, Sendable {
    public let id: String
    public let slug: String
}
