import XCTest
@testable import KreviaCore

@MainActor
final class EmployeesListViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> BillingService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return BillingService(client: client)
    }

    func testLoadPopulatesEmployeesAndClearsLoading() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: """
            [{"pluginInstallationId":"plugin-1","name":"Sales","type":"sales-employee","active":true,
              "conversations":12,"leadsGenerated":3,"creditsConsumed":48,"lastActivityAt":null}]
            """)
        }
        let viewModel = EmployeesListViewModel(billingService: service)
        await viewModel.load()
        XCTAssertEqual(viewModel.employees.count, 1)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
    }

    func testEmptyResultSetsEmptyState() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: "[]")
        }
        let viewModel = EmployeesListViewModel(billingService: service)
        await viewModel.load()
        XCTAssertTrue(viewModel.isEmpty)
    }

    func testForbiddenSurfacesRBACErrorWithoutCrashing() async {
        let service = makeService { request in
            jsonResponse(
                request.url!, status: 403,
                json: #"{"error":{"code":"FORBIDDEN","message":"You do not have permission to view usage.","details":[],"requestId":"r1","timestamp":"2026-09-27T00:00:00.000Z"}}"#
            )
        }
        let viewModel = EmployeesListViewModel(billingService: service)
        await viewModel.load()
        XCTAssertEqual(viewModel.errorMessage, "You do not have permission to view usage.")
        XCTAssertTrue(viewModel.employees.isEmpty)
    }
}
