import Foundation

/// Matches apps/api/src/identity/presentation/http/api-exception.filter.ts's global error envelope:
/// `{ "error": { "code", "message", "details", "requestId", "timestamp" } }`.
public struct APIErrorBody: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let details: [String]
    public let requestId: String?
    public let timestamp: String?
}

public struct APIErrorEnvelope: Codable, Equatable, Sendable {
    public let error: APIErrorBody
}

public enum APIError: Error, Equatable, Sendable {
    case network(String)
    case decoding(String)
    case unauthorized(APIErrorBody?)
    case forbidden(APIErrorBody?)
    case notFound(APIErrorBody?)
    case server(status: Int, body: APIErrorBody?)
    case timeout
    case cancelled
    case invalidResponse

    public var isUnauthorized: Bool { if case .unauthorized = self { return true }; return false }
    public var isForbidden: Bool { if case .forbidden = self { return true }; return false }

    /// Non-sensitive, user-facing message — never includes raw tokens/credentials.
    public var userMessage: String {
        switch self {
        case .network(let message): return message
        case .decoding: return "We couldn't read the server's response. Please try again."
        case .unauthorized(let body): return body?.message ?? "Your session has expired. Please sign in again."
        case .forbidden(let body): return body?.message ?? "You don't have permission to do that."
        case .notFound(let body): return body?.message ?? "That item couldn't be found."
        case .server(_, let body): return body?.message ?? "Something went wrong. Please try again."
        case .timeout: return "The request timed out. Please check your connection and try again."
        case .cancelled: return "Request cancelled."
        case .invalidResponse: return "Unexpected response from the server."
        }
    }
}
