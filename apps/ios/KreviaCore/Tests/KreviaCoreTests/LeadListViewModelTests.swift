import XCTest
@testable import KreviaCore

@MainActor
final class LeadListViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> LeadService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return LeadService(client: client)
    }

    private func lead(_ ref: String) -> String {
        """
        {"id":"\(ref)","organizationId":"org-1","leadReferenceId":"\(ref)","name":"Test","phone":null,"email":null,
         "source":"WEB_CHAT","agentId":null,"conversationId":null,"interactionId":null,"voiceSessionId":null,
         "requirement":null,"status":"NEW","priority":"MEDIUM","assignedToUserId":null,
         "createdAt":"2026-09-21T00:00:00.000Z","updatedAt":"2026-09-21T00:00:00.000Z",
         "lastActivityAt":"2026-09-21T00:00:00.000Z","convertedAt":null,"lostAt":null}
        """
    }

    func testLoadFirstPagePopulatesLeadsAndClearsLoading() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.lead("L-1"))],"total":1,"page":1,"pageSize":20,"totalPages":1}"#)
        }
        let viewModel = LeadListViewModel(leadService: service)
        await viewModel.loadFirstPage()
        XCTAssertEqual(viewModel.leads.count, 1)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isEmpty)
    }

    func testEmptyResultSetsEmptyState() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"items":[],"total":0,"page":1,"pageSize":20,"totalPages":1}"#)
        }
        let viewModel = LeadListViewModel(leadService: service)
        await viewModel.loadFirstPage()
        XCTAssertTrue(viewModel.isEmpty)
    }

    func testErrorSetsErrorMessageAndCanRetry() async {
        let service = makeService { request in
            jsonResponse(
                request.url!,
                status: 500,
                json: #"{"error":{"code":"INTERNAL_ERROR","message":"Server error.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
            )
        }
        let viewModel = LeadListViewModel(leadService: service)
        await viewModel.loadFirstPage()
        XCTAssertEqual(viewModel.errorMessage, "Server error.")
        XCTAssertTrue(viewModel.leads.isEmpty)
    }

    func testLoadNextPageIfNeededAppendsAndAdvancesPage() async {
        var callCount = 0
        let service = makeService { request in
            callCount += 1
            if callCount == 1 {
                return jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.lead("L-1"))],"total":2,"page":1,"pageSize":1,"totalPages":2}"#)
            }
            return jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.lead("L-2"))],"total":2,"page":2,"pageSize":1,"totalPages":2}"#)
        }
        let viewModel = LeadListViewModel(leadService: service)
        await viewModel.loadFirstPage()
        XCTAssertEqual(viewModel.leads.count, 1)
        guard let last = viewModel.leads.last else { return XCTFail("expected a lead") }
        await viewModel.loadNextPageIfNeeded(currentItem: last)
        XCTAssertEqual(viewModel.leads.count, 2)
        XCTAssertEqual(viewModel.leads.map(\.id), ["L-1", "L-2"])
    }
}
