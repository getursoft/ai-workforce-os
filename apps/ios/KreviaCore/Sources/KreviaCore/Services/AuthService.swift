import Foundation

/// Maps 1:1 to apps/api/src/identity/presentation/http/auth.controller.ts.
public struct AuthService: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func login(email: String, password: String, organizationName: String) async throws -> AuthenticationResult {
        let body = LoginRequest(email: email, password: password, organizationName: organizationName)
        return try await client.request(.post, "/auth/login", body: body, authorized: false)
    }

    public func me() async throws -> CurrentUserResult {
        try await client.request(.get, "/auth/me")
    }

    public func permissions() async throws -> [String] {
        let result: PermissionsResult = try await client.request(.get, "/auth/me/permissions")
        return result.permissions
    }

    /// Revokes the refresh token server-side. Best-effort: callers should clear local Keychain state
    /// regardless of whether this call succeeds (e.g. the token was already expired/revoked).
    public func logout(refreshToken: String) async throws {
        try await client.requestVoid(.post, "/auth/logout", body: RefreshRequest(refreshToken: refreshToken))
    }
}
