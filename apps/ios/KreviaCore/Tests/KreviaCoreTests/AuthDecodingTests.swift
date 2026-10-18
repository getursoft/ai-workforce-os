import XCTest
@testable import KreviaCore

final class AuthDecodingTests: XCTestCase {
    func testDecodesLoginEnvelope() throws {
        // Matches AuthController.login's real `{ data: AuthenticationResult }` envelope.
        let json = """
        {
          "data": {
            "organization": { "id": "org-1", "name": "Acme", "slug": "acme", "status": "ACTIVE" },
            "user": {
              "id": "user-1", "organizationId": "org-1", "firstName": "Owner",
              "email": "owner@example.com", "role": "OWNER", "status": "ACTIVE", "isPlatformOwner": false
            },
            "tokens": {
              "accessToken": "eyAccess", "refreshToken": "eyRefresh",
              "accessTokenExpiresIn": 900, "refreshTokenExpiresIn": 2592000
            }
          }
        }
        """
        struct Envelope: Decodable { let data: AuthenticationResult }
        let result = try makeDecoder().decode(Envelope.self, from: Data(json.utf8)).data
        XCTAssertEqual(result.organization.slug, "acme")
        XCTAssertEqual(result.user.role, "OWNER")
        XCTAssertEqual(result.tokens.accessTokenExpiresIn, 900)
    }

    func testDecodesErrorEnvelope() throws {
        let json = """
        { "error": { "code": "AUTHENTICATION_FAILED", "message": "Invalid credentials.", "details": [], "requestId": "req-1", "timestamp": "2026-09-21T09:00:00.000Z" } }
        """
        let envelope = try JSONDecoder().decode(APIErrorEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.error.code, "AUTHENTICATION_FAILED")
        XCTAssertEqual(envelope.error.message, "Invalid credentials.")
    }
}
