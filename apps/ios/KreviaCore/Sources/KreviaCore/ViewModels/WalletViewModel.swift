import Foundation

/// Wallet screen: available/purchased/consumed credits and the recharge flow. The app never modifies a
/// balance directly — it only ever creates a PENDING purchase order server-side and hands the gateway's
/// order id back to a checkout SDK; only a server-verified payment (see `BillingService.verifyOrder`,
/// which re-derives the Razorpay signature) raises the allowance.
@MainActor
public final class WalletViewModel: ObservableObject {
    @Published public private(set) var summary: UsageSummary?
    @Published public private(set) var packages: [CreditPackage] = []
    /// Sum of PAID recharge orders — real transaction data, never an estimate.
    @Published public private(set) var purchasedCredits = 0
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var isStartingRecharge = false
    @Published public private(set) var pendingOrder: CreditPurchaseOrderView?
    @Published public var rechargeErrorMessage: String?

    private let billingService: BillingService

    public init(billingService: BillingService) {
        self.billingService = billingService
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            async let summaryResult = billingService.summary()
            async let packagesResult = billingService.packages()
            async let ordersResult = billingService.listOrders()
            let (s, p, orders) = try await (summaryResult, packagesResult, ordersResult)
            summary = s
            packages = p.packages
            purchasedCredits = orders.filter { $0.status == "PAID" }.reduce(0) { $0 + $1.credits }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func startRecharge(credits: Int) async {
        isStartingRecharge = true
        rechargeErrorMessage = nil
        do {
            pendingOrder = try await billingService.createOrder(credits: credits)
        } catch let error as APIError {
            rechargeErrorMessage = error.userMessage
        } catch {
            rechargeErrorMessage = "Something went wrong. Please try again."
        }
        isStartingRecharge = false
    }

    public func clearPendingOrder() {
        pendingOrder = nil
    }
}
