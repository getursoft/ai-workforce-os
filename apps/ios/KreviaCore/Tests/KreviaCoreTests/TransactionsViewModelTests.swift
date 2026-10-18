import XCTest
@testable import KreviaCore

@MainActor
final class TransactionsViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> BillingService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return BillingService(client: client)
    }

    func testMergesRechargeOrdersAndUsageDebitsSortedNewestFirst() async {
        let service = makeService { request in
            if request.url!.path.contains("orders") {
                return jsonResponse(request.url!, status: 200, json: """
                [{"id":"order-1","credits":10000,"amountMinor":1000000,"currency":"INR","status":"PAID",
                  "gateway":"RAZORPAY","createdAt":"2026-09-20T10:00:00.000Z","paidAt":"2026-09-20T10:05:00.000Z"}]
                """)
            }
            return jsonResponse(request.url!, status: 200, json: """
            [{"date":"2026-09-18","creditsConsumed":0,"inputTokens":0,"outputTokens":0,"totalTokens":0,"requests":0},
             {"date":"2026-09-25","creditsConsumed":12,"inputTokens":100,"outputTokens":50,"totalTokens":150,"requests":3}]
            """)
        }
        let viewModel = TransactionsViewModel(billingService: service)
        await viewModel.load()

        // The zero-credit day is filtered out (not a real debit); order-1 (Sep 20) sorts after Sep 25's debit.
        XCTAssertEqual(viewModel.transactions.count, 2)
        XCTAssertEqual(viewModel.transactions.first?.typeLabel, "Usage Debit")
        XCTAssertEqual(viewModel.transactions.first?.creditsDelta, -12)
        XCTAssertEqual(viewModel.transactions.last?.typeLabel, "Recharge")
        XCTAssertEqual(viewModel.transactions.last?.creditsDelta, 10000)
        XCTAssertFalse(viewModel.isLoading)
    }

    func testEmptyHistorySetsEmptyState() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: "[]")
        }
        let viewModel = TransactionsViewModel(billingService: service)
        await viewModel.load()
        XCTAssertTrue(viewModel.isEmpty)
    }
}
