import Foundation

public enum UsagePeriod: String, CaseIterable, Identifiable, Sendable {
    case today = "Today"
    case sevenDays = "7 Days"
    case thirtyDays = "30 Days"

    public var id: String { rawValue }

    var daysBack: Int {
        switch self {
        case .today: return 0
        case .sevenDays: return 6
        case .thirtyDays: return 29
        }
    }
}

/// Usage screen — current balance plus breakdowns for the selected period. Every number comes from
/// `/billing/usage/*`; nothing is computed or estimated on-device.
@MainActor
public final class UsageViewModel: ObservableObject {
    @Published public var period: UsagePeriod = .today
    @Published public private(set) var summary: UsageSummary?
    @Published public private(set) var byEmployee: [EmployeeUsageShare] = []
    @Published public private(set) var byModel: [ModelUsage] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?

    private let billingService: BillingService

    public init(billingService: BillingService) {
        self.billingService = billingService
    }

    private func range(for period: UsagePeriod) -> (start: Date, end: Date) {
        let calendar = Calendar(identifier: .gregorian)
        let end = Date()
        let start = calendar.date(byAdding: .day, value: -period.daysBack, to: calendar.startOfDay(for: end)) ?? end
        return (start, end)
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        let range = range(for: period)
        do {
            async let summaryResult = billingService.summary(start: range.start, end: range.end)
            async let employeeResult = billingService.byEmployee(start: range.start, end: range.end)
            async let modelResult = billingService.byModel(start: range.start, end: range.end)
            let (s, e, m) = try await (summaryResult, employeeResult, modelResult)
            summary = s
            byEmployee = e
            byModel = m
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }
}
