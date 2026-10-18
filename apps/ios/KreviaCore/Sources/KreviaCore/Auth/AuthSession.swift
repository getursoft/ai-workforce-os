import Foundation

/// Holds the current authenticated session (tokens in Keychain only; user/org kept in memory,
/// rehydrated from `GET /auth/me` on launch — never persisted in UserDefaults).
@MainActor
public final class AuthSession: ObservableObject {
    private static let accessTokenKey = "accessToken"
    private static let refreshTokenKey = "refreshToken"

    private let tokenStore: SecureTokenStore

    @Published public private(set) var currentUser: PublicUser?
    @Published public private(set) var currentOrganization: PublicOrganization?
    @Published public private(set) var isAuthenticated: Bool = false

    public init(tokenStore: SecureTokenStore = KeychainStore()) {
        self.tokenStore = tokenStore
        self.isAuthenticated = (try? tokenStore.read(for: Self.accessTokenKey)) != nil
    }

    public var accessToken: String? {
        try? tokenStore.read(for: Self.accessTokenKey)
    }

    public var refreshToken: String? {
        try? tokenStore.read(for: Self.refreshTokenKey)
    }

    public func store(authentication: AuthenticationResult) throws {
        try tokenStore.save(authentication.tokens.accessToken, for: Self.accessTokenKey)
        try tokenStore.save(authentication.tokens.refreshToken, for: Self.refreshTokenKey)
        currentUser = authentication.user
        currentOrganization = authentication.organization
        isAuthenticated = true
    }

    public func storeRefreshedTokens(_ tokens: TokenPair) throws {
        try tokenStore.save(tokens.accessToken, for: Self.accessTokenKey)
        try tokenStore.save(tokens.refreshToken, for: Self.refreshTokenKey)
    }

    public func updateProfile(_ result: CurrentUserResult) {
        currentUser = result.user
        currentOrganization = result.organization
    }

    /// Secure token deletion — clears Keychain entries and in-memory state. Never logs the values.
    public func clear() {
        try? tokenStore.delete(for: Self.accessTokenKey)
        try? tokenStore.delete(for: Self.refreshTokenKey)
        currentUser = nil
        currentOrganization = nil
        isAuthenticated = false
    }
}
