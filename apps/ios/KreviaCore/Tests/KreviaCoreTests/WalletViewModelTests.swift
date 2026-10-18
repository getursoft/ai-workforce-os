import XCTest
@testable import KreviaCore

@MainActor
final class WalletViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> BillingService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return BillingService(client: client)
    }

    func testLoadPopulatesBalancePackagesAndPurchasedCredits() async {
        let service = makeService { request in
            if request.url!.path.contains("packages") {
                return jsonResponse(request.url!, status: 200, json: """
                {"currency":"INR","packages":[{"credits":10000,"amountMinor":1000000,"currency":"INR"}]}
                """)
            }
            if request.url!.path.contains("orders") {
                return jsonResponse(request.url!, status: 200, json: """
                [{"id":"order-1","credits":10000,"amountMinor":1000000,"currency":"INR","status":"PAID",
                  "gateway":"RAZORPAY","createdAt":"2026-09-20T10:00:00.000Z","paidAt":"2026-09-20T10:05:00.000Z"},
                 {"id":"order-2","credits":5000,"amountMinor":500000,"currency":"INR","status":"PENDING",
                  "gateway":"RAZORPAY","createdAt":"2026-09-21T10:00:00.000Z","paidAt":null}]
                """)
            }
            return jsonResponse(request.url!, status: 200, json: """
            {"plan":{"code":"GROWTH","name":"Growth"},"billingCycle":null,"currency":"INR",
             "monthlyAllowanceCredits":500000,"usedCredits":120000,"remainingCredits":380000,
             "usagePercentage":24,"estimatedOverageAmountMinor":0,"threshold":"NORMAL",
             "tokens":{"input":0,"output":0,"cachedInput":0,"reasoning":0,"total":0},"totalRequests":0}
            """)
        }
        let viewModel = WalletViewModel(billingService: service)
        await viewModel.load()
        XCTAssertEqual(viewModel.summary?.remainingCredits, 380000)
        XCTAssertEqual(viewModel.packages.count, 1)
        // Only the PAID order counts toward purchased credits — the PENDING one hasn't been paid yet.
        XCTAssertEqual(viewModel.purchasedCredits, 10000)
    }

    /// A recharge only ever stores exactly what the server returned (a PENDING order) — there is no code
    /// path in the app that marks a purchase PAID or increases a balance on its own say-so.
    func testStartRechargeStoresExactlyTheServerReturnedPendingOrder() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: """
            {"id":"order-1","credits":10000,"amountMinor":1000000,"currency":"INR","status":"PENDING",
             "gatewayOrderId":"order_gw_1","razorpayKeyId":"rzp_test_key"}
            """)
        }
        let viewModel = WalletViewModel(billingService: service)
        await viewModel.startRecharge(credits: 10000)
        XCTAssertEqual(viewModel.pendingOrder?.status, "PENDING")
        XCTAssertEqual(viewModel.pendingOrder?.id, "order-1")
        XCTAssertFalse(viewModel.isStartingRecharge)
    }

    func testPaymentGatewayNotConfiguredSurfacesAsRechargeErrorNotCrash() async {
        let service = makeService { request in
            jsonResponse(
                request.url!, status: 422,
                json: #"{"error":{"code":"PAYMENT_GATEWAY_NOT_CONFIGURED","message":"Payments aren't set up for this workspace yet.","details":[],"requestId":"r1","timestamp":"2026-09-27T00:00:00.000Z"}}"#
            )
        }
        let viewModel = WalletViewModel(billingService: service)
        await viewModel.startRecharge(credits: 10000)
        XCTAssertNil(viewModel.pendingOrder)
        XCTAssertEqual(viewModel.rechargeErrorMessage, "Payments aren't set up for this workspace yet.")
    }

    func testForbiddenRechargeDoesNotCreateAnOrder() async {
        let service = makeService { request in
            jsonResponse(
                request.url!, status: 403,
                json: #"{"error":{"code":"FORBIDDEN","message":"Only billing-authorized users can recharge.","details":[],"requestId":"r1","timestamp":"2026-09-27T00:00:00.000Z"}}"#
            )
        }
        let viewModel = WalletViewModel(billingService: service)
        await viewModel.startRecharge(credits: 10000)
        XCTAssertNil(viewModel.pendingOrder)
        XCTAssertEqual(viewModel.rechargeErrorMessage, "Only billing-authorized users can recharge.")
    }
}
