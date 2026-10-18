import Foundation

@MainActor
public final class EmployeeDetailViewModel: ObservableObject {
    @Published public private(set) var detail: EmployeeDetail?
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var isUninstalling = false
    @Published public var uninstallError: String?

    private let billingService: BillingService
    private let pluginService: PluginService
    private let employeeId: String

    public init(employeeId: String, billingService: BillingService, pluginService: PluginService) {
        self.employeeId = employeeId
        self.billingService = billingService
        self.pluginService = pluginService
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            detail = try await billingService.employeeDetail(employeeId)
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    @discardableResult
    public func uninstall() async -> Bool {
        isUninstalling = true
        uninstallError = nil
        do {
            try await pluginService.uninstall(employeeId)
            isUninstalling = false
            return true
        } catch let error as APIError {
            uninstallError = error.userMessage
        } catch {
            uninstallError = "Couldn't uninstall this AI Employee. Please try again."
        }
        isUninstalling = false
        return false
    }
}
