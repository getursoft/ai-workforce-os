import XCTest
@testable import KreviaCore

@MainActor
final class EmployeeDetailViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> (BillingService, PluginService) {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return (BillingService(client: client), PluginService(client: client))
    }

    func testLoadPopulatesDetail() async {
        let (service, pluginService) = makeService { request in
            jsonResponse(request.url!, status: 200, json: """
            {"pluginInstallationId":"plugin-1","name":"Sales","type":"sales-employee","active":true,
             "usageToday":{"creditsConsumed":4,"executions":2},
             "usageWeek":{"creditsConsumed":20,"executions":10},
             "usageMonth":{"creditsConsumed":48,"executions":24},
             "leadsGenerated":3,"conversations":24,"recentActivity":[]}
            """)
        }
        let viewModel = EmployeeDetailViewModel(employeeId: "plugin-1", billingService: service, pluginService: pluginService)
        await viewModel.load()
        XCTAssertEqual(viewModel.detail?.name, "Sales")
        XCTAssertEqual(viewModel.detail?.usageMonth.creditsConsumed, 48)
    }

    func testNotFoundSurfacesAsErrorMessage() async {
        let (service, pluginService) = makeService { request in
            jsonResponse(
                request.url!, status: 404,
                json: #"{"error":{"code":"EMPLOYEE_NOT_FOUND","message":"That item couldn't be found.","details":[],"requestId":"r1","timestamp":"2026-09-27T00:00:00.000Z"}}"#
            )
        }
        let viewModel = EmployeeDetailViewModel(employeeId: "missing", billingService: service, pluginService: pluginService)
        await viewModel.load()
        XCTAssertNil(viewModel.detail)
        XCTAssertNotNil(viewModel.errorMessage)
    }
}
