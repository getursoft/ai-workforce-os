import Foundation

@MainActor
public final class EmployeesListViewModel: ObservableObject {
    @Published public private(set) var employees: [EmployeeOverview] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?

    private let billingService: BillingService

    public init(billingService: BillingService) {
        self.billingService = billingService
    }

    public var isEmpty: Bool { employees.isEmpty && !isLoading && errorMessage == nil }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            employees = try await billingService.employees()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func refresh() async {
        await load()
    }
}
