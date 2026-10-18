import Foundation

@MainActor
public final class EmployeeCatalogViewModel: ObservableObject {
    @Published public private(set) var items: [PluginCatalogItem] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var installingId: String?
    @Published public var installError: String?

    private let pluginService: PluginService

    public init(pluginService: PluginService) {
        self.pluginService = pluginService
    }

    public var isEmpty: Bool { items.isEmpty && !isLoading && errorMessage == nil }

    /// Dev/test-only manifests the backend's catalog can surface in non-production environments —
    /// filtered here so the catalog only ever shows real, installable AI Employees.
    private static let excludedIds: Set<String> = ["dummy-echo"]

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            items = try await pluginService.available().items.filter { !Self.excludedIds.contains($0.id) }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func install(_ item: PluginCatalogItem) async {
        installingId = item.id
        installError = nil
        do {
            _ = try await pluginService.install(pluginId: item.id)
            if let index = items.firstIndex(where: { $0.id == item.id }) {
                items[index] = PluginCatalogItem(
                    id: item.id, name: item.name, displayName: item.displayName,
                    description: item.description, installed: true
                )
            }
        } catch let error as APIError {
            installError = error.userMessage
        } catch {
            installError = "Couldn't install this AI Employee. Please try again."
        }
        installingId = nil
    }
}
