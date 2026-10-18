import Foundation

/// Merges two real backend sources into one feed — recharge orders (`/billing/credit-purchase/orders`)
/// and daily usage debits (`/billing/usage/trend`) — rather than the backend inventing a synthetic
/// combined ledger it doesn't otherwise need.
@MainActor
public final class TransactionsViewModel: ObservableObject {
    @Published public private(set) var transactions: [BillingTransaction] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?

    private let billingService: BillingService

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.calendar = Calendar(identifier: .gregorian)
        return formatter
    }()

    public init(billingService: BillingService) {
        self.billingService = billingService
    }

    public var isEmpty: Bool { transactions.isEmpty && !isLoading && errorMessage == nil }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let calendar = Calendar(identifier: .gregorian)
            let end = Date()
            let start = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: end)) ?? end
            async let ordersResult = billingService.listOrders()
            async let trendResult = billingService.trend(start: start, end: end)
            let (orders, trend) = try await (ordersResult, trendResult)

            let recharges = orders.map { BillingTransaction(id: "order-\($0.id)", date: $0.createdAt, kind: .recharge($0)) }
            let debits = trend
                .filter { $0.creditsConsumed > 0 }
                .compactMap { point -> BillingTransaction? in
                    guard let date = Self.dayFormatter.date(from: point.date) else { return nil }
                    return BillingTransaction(id: "usage-\(point.date)", date: date, kind: .usageDebit(point))
                }
            transactions = (recharges + debits).sorted { $0.date > $1.date }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }
}
