import Foundation

/// Maps 1:1 to apps/api/src/billing/billing.controller.ts and credit-purchase.controller.ts
/// (`/api/v1/billing/*`). No separate wallet/ledger table server-side — a purchased top-up raises the
/// organization's effective monthly allowance, and `remainingCredits` is always server-computed.
public struct BillingService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    // ISO8601DateFormatter isn't Sendable, but this is configured once and only ever read — same
    // reasoning as APIClient's date formatters.
    nonisolated(unsafe) private static let isoDay: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter
    }()

    private func rangeQuery(start: Date?, end: Date?) -> [URLQueryItem] {
        guard let start, let end else { return [] }
        return [
            URLQueryItem(name: "start", value: Self.isoDay.string(from: start)),
            URLQueryItem(name: "end", value: Self.isoDay.string(from: end))
        ]
    }

    public func summary(start: Date? = nil, end: Date? = nil) async throws -> UsageSummary {
        try await client.request(.get, "/billing/usage/summary", query: rangeQuery(start: start, end: end))
    }

    public func employees(start: Date? = nil, end: Date? = nil) async throws -> [EmployeeOverview] {
        try await client.request(.get, "/billing/usage/employees", query: rangeQuery(start: start, end: end))
    }

    public func employeeDetail(_ id: String) async throws -> EmployeeDetail {
        try await client.request(.get, "/billing/usage/employees/\(id)")
    }

    public func byEmployee(start: Date, end: Date) async throws -> [EmployeeUsageShare] {
        try await client.request(.get, "/billing/usage/by-employee", query: rangeQuery(start: start, end: end))
    }

    public func byCapability(start: Date, end: Date) async throws -> [CapabilityUsage] {
        try await client.request(.get, "/billing/usage/by-capability", query: rangeQuery(start: start, end: end))
    }

    public func byModel(start: Date, end: Date) async throws -> [ModelUsage] {
        try await client.request(.get, "/billing/usage/by-model", query: rangeQuery(start: start, end: end))
    }

    public func trend(start: Date, end: Date) async throws -> [UsageTrendPoint] {
        try await client.request(.get, "/billing/usage/trend", query: rangeQuery(start: start, end: end))
    }

    public func packages() async throws -> CreditPackagesResponse {
        try await client.request(.get, "/billing/credit-purchase/packages")
    }

    public func listOrders() async throws -> [CreditPurchaseOrderSummary] {
        try await client.request(.get, "/billing/credit-purchase/orders")
    }

    public func createOrder(credits: Int) async throws -> CreditPurchaseOrderView {
        try await client.request(.post, "/billing/credit-purchase/orders", body: CreateCreditPurchaseOrderRequest(credits: credits))
    }

    public func verifyOrder(_ id: String, _ payload: VerifyCreditPurchaseOrderRequest) async throws -> VerifyCreditPurchaseOrderResult {
        try await client.request(.post, "/billing/credit-purchase/orders/\(id)/verify", body: payload)
    }
}

public struct VerifyCreditPurchaseOrderResult: Codable, Equatable, Sendable {
    public let status: String
    public let credits: Int
}
