import Foundation

// MARK: - Employees (GET /billing/usage/employees[/:id])

public struct EmployeeOverview: Codable, Identifiable, Equatable, Sendable {
    public var id: String { pluginInstallationId }
    public let pluginInstallationId: String
    public let name: String
    public let type: String
    public let active: Bool
    public let conversations: Int
    public let leadsGenerated: Int
    public let creditsConsumed: Int
    public let lastActivityAt: Date?
}

public struct EmployeeUsageWindow: Codable, Equatable, Sendable {
    public let creditsConsumed: Int
    public let executions: Int
}

public struct EmployeeActivityEvent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let occurredAt: Date
    public let creditsConsumed: Int
}

public struct EmployeeDetail: Codable, Identifiable, Equatable, Sendable {
    public var id: String { pluginInstallationId }
    public let pluginInstallationId: String
    public let name: String
    public let type: String
    public let active: Bool
    public let usageToday: EmployeeUsageWindow
    public let usageWeek: EmployeeUsageWindow
    public let usageMonth: EmployeeUsageWindow
    public let leadsGenerated: Int
    public let conversations: Int
    public let recentActivity: [EmployeeActivityEvent]
}

// MARK: - Usage (GET /billing/usage/summary, by-employee, by-capability, by-model, trend)

public struct PlanInfo: Codable, Equatable, Sendable {
    public let code: String
    public let name: String
}

public struct BillingCycle: Codable, Equatable, Sendable {
    public let start: Date
    public let end: Date
}

public enum UsageThreshold: String, Codable, Sendable {
    case normal = "NORMAL"
    case informational = "INFORMATIONAL"
    case warning = "WARNING"
    case limitReached = "LIMIT_REACHED"
    case overage = "OVERAGE"
}

public struct TokenBreakdown: Codable, Equatable, Sendable {
    public let input: Int
    public let output: Int
    public let cachedInput: Int
    public let reasoning: Int
    public let total: Int
}

public struct UsageSummary: Codable, Equatable, Sendable {
    public let plan: PlanInfo?
    public let billingCycle: BillingCycle?
    public let currency: String
    public let monthlyAllowanceCredits: Int
    public let usedCredits: Int
    public let remainingCredits: Int
    public let usagePercentage: Double
    public let estimatedOverageAmountMinor: Int
    public let threshold: UsageThreshold
    public let tokens: TokenBreakdown
    public let totalRequests: Int
}

public struct EmployeeUsageShare: Codable, Identifiable, Equatable, Sendable {
    public var id: String { pluginInstallationId }
    public let pluginInstallationId: String
    public let employeeName: String
    public let creditsConsumed: Int
    public let sharePercentage: Double
    public let inputTokens: Int
    public let outputTokens: Int
    public let executions: Int
}

public struct CapabilityUsage: Codable, Identifiable, Equatable, Sendable {
    public var id: String { capability }
    public let capability: String
    public let displayName: String
    public let creditsConsumed: Int
    public let sharePercentage: Double
}

public struct ModelUsage: Codable, Identifiable, Equatable, Sendable {
    public var id: String { "\(provider)/\(model)" }
    public let provider: String
    public let model: String
    public let inputTokens: Int
    public let cachedInputTokens: Int
    public let outputTokens: Int
    public let reasoningTokens: Int
    public let totalTokens: Int
    public let creditsConsumed: Int
    public let internalCostAmountMinor: Int?
}

public struct UsageTrendPoint: Codable, Identifiable, Equatable, Sendable {
    public var id: String { date }
    public let date: String
    public let creditsConsumed: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int
    public let requests: Int
}

// MARK: - Wallet / Recharge (GET/POST /billing/credit-purchase/*)

public struct CreditPackage: Codable, Identifiable, Equatable, Sendable {
    public var id: Int { credits }
    public let credits: Int
    public let amountMinor: Int
    public let currency: String
}

public struct CreditPackagesResponse: Codable, Equatable, Sendable {
    public let currency: String
    public let packages: [CreditPackage]
}

/// Response from `POST /billing/credit-purchase/orders` — a freshly created PENDING order plus the
/// gateway's own order id and the account's publishable key (never a secret) for client-side checkout.
public struct CreditPurchaseOrderView: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let credits: Int
    public let amountMinor: Int
    public let currency: String
    public let status: String
    public let gatewayOrderId: String?
    public let razorpayKeyId: String
}

/// A row in `GET /billing/credit-purchase/orders` — the recharge transaction ledger.
public struct CreditPurchaseOrderSummary: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let credits: Int
    public let amountMinor: Int
    public let currency: String
    public let status: String
    public let gateway: String
    public let createdAt: Date
    public let paidAt: Date?
}

public struct CreateCreditPurchaseOrderRequest: Codable, Sendable {
    public let credits: Int
    public init(credits: Int) { self.credits = credits }
}

public struct VerifyCreditPurchaseOrderRequest: Codable, Sendable {
    public let razorpayOrderId: String
    public let razorpayPaymentId: String
    public let razorpaySignature: String
    public init(razorpayOrderId: String, razorpayPaymentId: String, razorpaySignature: String) {
        self.razorpayOrderId = razorpayOrderId
        self.razorpayPaymentId = razorpayPaymentId
        self.razorpaySignature = razorpaySignature
    }
}

/// Client-side merge of two real, server-authoritative sources — `CreditPurchaseOrderSummary` (recharges)
/// and `UsageTrendPoint` (daily usage debits) — into one sorted feed for the Transactions screen. Never a
/// separate ledger; the app never invents a balance or a transaction the backend didn't report.
public enum BillingTransactionKind: Sendable, Equatable {
    case recharge(CreditPurchaseOrderSummary)
    case usageDebit(UsageTrendPoint)
}

public struct BillingTransaction: Identifiable, Equatable, Sendable {
    public let id: String
    public let date: Date
    public let kind: BillingTransactionKind

    public var typeLabel: String {
        switch kind {
        case .recharge: return "Recharge"
        case .usageDebit: return "Usage Debit"
        }
    }

    public var statusLabel: String {
        switch kind {
        case .recharge(let order): return order.status
        case .usageDebit: return "FINAL"
        }
    }

    public var creditsDelta: Int {
        switch kind {
        case .recharge(let order): return order.credits
        case .usageDebit(let point): return -point.creditsConsumed
        }
    }

    public var reference: String {
        switch kind {
        case .recharge(let order): return order.id
        case .usageDebit(let point): return "usage-\(point.date)"
        }
    }
}
