import Foundation

// Matches apps/api/src/identity/application/models/identity-result.ts

public struct PublicOrganization: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let status: String
}

public struct PublicUser: Codable, Equatable, Sendable {
    public let id: String
    public let organizationId: String
    public let firstName: String
    public let lastName: String?
    public let email: String
    public let role: String
    public let status: String
    public let isPlatformOwner: Bool
}

public struct TokenPair: Codable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let accessTokenExpiresIn: Int
    public let refreshTokenExpiresIn: Int
}

/// Matches AuthenticationResult — the payload of `POST /auth/login` and `POST /auth/refresh`.
public struct AuthenticationResult: Codable, Equatable, Sendable {
    public let organization: PublicOrganization
    public let user: PublicUser
    public let tokens: TokenPair
}

public struct CurrentUserResult: Codable, Equatable, Sendable {
    public let organization: PublicOrganization
    public let user: PublicUser
}

public struct PermissionsResult: Codable, Equatable, Sendable {
    public let permissions: [String]
}

public struct LoginRequest: Codable, Sendable {
    public let email: String
    public let password: String
    public let organizationName: String

    public init(email: String, password: String, organizationName: String) {
        self.email = email
        self.password = password
        self.organizationName = organizationName
    }
}

public struct RefreshRequest: Codable, Sendable {
    public let refreshToken: String
}
