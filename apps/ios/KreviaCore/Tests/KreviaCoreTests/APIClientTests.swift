import XCTest
@testable import KreviaCore

final class APIClientTests: XCTestCase {
    private func makeClient(tokenStore: SecureTokenStore = InMemoryTokenStore()) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: tokenStore
        )
    }

    func testSuccessfulRequestDecodesEnvelopedResponse() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(request.url!, status: 200, json: #"{"data":{"permissions":["leads.read"]}}"#)
        }
        let client = makeClient()
        let result: PermissionsResult = try await client.request(.get, "/auth/me/permissions")
        XCTAssertEqual(result.permissions, ["leads.read"])
    }

    func testSuccessfulRequestDecodesUnenvelopedLeadsResponse() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(request.url!, status: 200, json: #"{"total":3,"new":1,"contacted":0,"qualified":1,"followUp":0,"converted":1,"lost":0}"#)
        }
        let client = makeClient()
        let summary: LeadSummary = try await client.request(.get, "/leads/summary")
        XCTAssertEqual(summary.total, 3)
    }

    func testSendsBearerHeaderWhenAuthorized() async throws {
        let store = InMemoryTokenStore()
        try store.save("token-123", for: "accessToken")
        var capturedAuth: String?
        MockURLProtocol.handler = { request in
            capturedAuth = request.value(forHTTPHeaderField: "Authorization")
            return jsonResponse(request.url!, status: 200, json: #"{"total":0,"new":0,"contacted":0,"qualified":0,"followUp":0,"converted":0,"lost":0}"#)
        }
        let client = makeClient(tokenStore: store)
        let _: LeadSummary = try await client.request(.get, "/leads/summary")
        XCTAssertEqual(capturedAuth, "Bearer token-123")
    }

    func testEncodesQueryParametersForPagination() async throws {
        var capturedURL: URL?
        MockURLProtocol.handler = { request in
            capturedURL = request.url
            return jsonResponse(request.url!, status: 200, json: #"{"items":[],"total":0,"page":2,"pageSize":20,"totalPages":3}"#)
        }
        let client = makeClient()
        let query = ListLeadsQuery(page: 2, pageSize: 20, status: .new, search: "arjun")
        let page: LeadPage = try await client.request(.get, "/leads", query: query.queryItems)
        XCTAssertEqual(page.page, 2)
        XCTAssertEqual(page.totalPages, 3)
        let urlString = capturedURL?.absoluteString ?? ""
        XCTAssertTrue(urlString.contains("page=2"))
        XCTAssertTrue(urlString.contains("status=NEW"))
        XCTAssertTrue(urlString.contains("search=arjun"))
    }

    func test401WithoutRefreshTokenThrowsUnauthorized() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(
                request.url!,
                status: 401,
                json: #"{"error":{"code":"AUTHENTICATION_FAILED","message":"Auth required.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
            )
        }
        let client = makeClient()
        do {
            let _: LeadSummary = try await client.request(.get, "/leads/summary")
            XCTFail("expected unauthorized")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
        }
    }

    func test403ThrowsForbiddenWithServerMessage() async throws {
        let store = InMemoryTokenStore()
        try store.save("token-123", for: "accessToken")
        MockURLProtocol.handler = { request in
            jsonResponse(
                request.url!,
                status: 403,
                json: #"{"error":{"code":"AUTHORIZATION_FAILED","message":"You don't have permission.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
            )
        }
        let client = makeClient(tokenStore: store)
        do {
            let _: Lead = try await client.request(.post, "/leads")
            XCTFail("expected forbidden")
        } catch let error as APIError {
            XCTAssertTrue(error.isForbidden)
            XCTAssertEqual(error.userMessage, "You don't have permission.")
        }
    }

    func test404ThrowsNotFound() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(
                request.url!,
                status: 404,
                json: #"{"error":{"code":"RESOURCE_NOT_FOUND","message":"Not found.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
            )
        }
        let client = makeClient()
        do {
            let _: Lead = try await client.request(.get, "/leads/does-not-exist")
            XCTFail("expected not found")
        } catch let error as APIError {
            if case .notFound = error {} else { XCTFail("expected .notFound, got \(error)") }
        }
    }

    func test500MapsToServerError() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(
                request.url!,
                status: 500,
                json: #"{"error":{"code":"INTERNAL_ERROR","message":"Boom.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
            )
        }
        let client = makeClient()
        do {
            let _: Lead = try await client.request(.get, "/leads/x")
            XCTFail("expected server error")
        } catch let error as APIError {
            if case .server(let status, _) = error { XCTAssertEqual(status, 500) } else { XCTFail("wrong case") }
        }
    }

    func testMalformedJSONMapsToDecodingError() async throws {
        MockURLProtocol.handler = { request in
            jsonResponse(request.url!, status: 200, json: "{not valid json")
        }
        let client = makeClient()
        do {
            let _: LeadSummary = try await client.request(.get, "/leads/summary")
            XCTFail("expected decoding error")
        } catch let error as APIError {
            if case .decoding = error {} else { XCTFail("expected .decoding, got \(error)") }
        }
    }

    func testRefreshesTokenOnceAndRetriesAfterFirst401() async throws {
        let store = InMemoryTokenStore()
        try store.save("expired-access", for: "accessToken")
        try store.save("valid-refresh", for: "refreshToken")

        var requestCount = 0
        MockURLProtocol.handler = { request in
            requestCount += 1
            if request.url!.path.hasSuffix("/auth/refresh") {
                return jsonResponse(
                    request.url!,
                    status: 200,
                    json: #"""
                    {"data":{
                      "organization":{"id":"org-1","name":"Acme","slug":"acme","status":"ACTIVE"},
                      "user":{"id":"user-1","organizationId":"org-1","firstName":"Owner","email":"o@example.com","role":"OWNER","status":"ACTIVE","isPlatformOwner":false},
                      "tokens":{"accessToken":"new-access","refreshToken":"new-refresh","accessTokenExpiresIn":900,"refreshTokenExpiresIn":2592000}
                    }}
                    """#
                )
            }
            let auth = request.value(forHTTPHeaderField: "Authorization")
            if auth == "Bearer expired-access" {
                return jsonResponse(
                    request.url!,
                    status: 401,
                    json: #"{"error":{"code":"AUTHENTICATION_FAILED","message":"Expired.","details":[],"requestId":"r1","timestamp":"2026-09-21T00:00:00.000Z"}}"#
                )
            }
            XCTAssertEqual(auth, "Bearer new-access")
            return jsonResponse(request.url!, status: 200, json: #"{"total":1,"new":1,"contacted":0,"qualified":0,"followUp":0,"converted":0,"lost":0}"#)
        }
        let client = makeClient(tokenStore: store)
        let summary: LeadSummary = try await client.request(.get, "/leads/summary")
        XCTAssertEqual(summary.total, 1)
        XCTAssertEqual(requestCount, 3) // original (401) -> refresh -> retried (200)
        XCTAssertEqual(try store.read(for: "accessToken"), "new-access")
    }
}
