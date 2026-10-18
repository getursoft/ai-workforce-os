import XCTest
@testable import KreviaCore

@MainActor
final class UsageViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> BillingService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return BillingService(client: client)
    }

    func testLoadPopulatesSummaryAndBreakdownsForSelectedPeriod() async {
        let service = makeService { request in
            if request.url!.path.contains("by-employee") {
                return jsonResponse(request.url!, status: 200, json: """
                [{"pluginInstallationId":"plugin-1","employeeName":"Sales","creditsConsumed":10,
                  "sharePercentage":100,"inputTokens":100,"outputTokens":50,"executions":2}]
                """)
            }
            if request.url!.path.contains("by-model") {
                return jsonResponse(request.url!, status: 200, json: "[]")
            }
            return jsonResponse(request.url!, status: 200, json: """
            {"plan":null,"billingCycle":null,"currency":"INR","monthlyAllowanceCredits":0,"usedCredits":10,
             "remainingCredits":380000,"usagePercentage":0,"estimatedOverageAmountMinor":0,"threshold":"NORMAL",
             "tokens":{"input":0,"output":0,"cachedInput":0,"reasoning":0,"total":0},"totalRequests":2}
            """)
        }
        let viewModel = UsageViewModel(billingService: service)
        viewModel.period = .sevenDays
        await viewModel.load()

        XCTAssertEqual(viewModel.summary?.usedCredits, 10)
        XCTAssertEqual(viewModel.byEmployee.count, 1)
        XCTAssertTrue(viewModel.byModel.isEmpty)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
    }
}
