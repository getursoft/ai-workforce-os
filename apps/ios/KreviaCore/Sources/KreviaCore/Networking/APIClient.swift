import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// One file in a `uploadMultipart` call — e.g. a resume picked via `.fileImporter`.
public struct MultipartFile: Sendable {
    public let filename: String
    public let mimeType: String
    public let data: Data

    public init(filename: String, mimeType: String, data: Data) {
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
    }
}

/// Reusable, typed API client used by every screen — no screen talks to URLSession directly.
/// Handles Bearer auth, the backend's response envelope, query parameters, timeouts, and a single
/// automatic refresh-and-retry on 401 (matching `POST /auth/refresh`'s body-token contract).
public actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private let tokenStore: SecureTokenStore
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// Invoked when a request fails 401 even after a refresh attempt — the app should log out.
    private var onSessionExpired: (@Sendable () -> Void)?

    public func setSessionExpiredHandler(_ handler: @escaping @Sendable () -> Void) {
        onSessionExpired = handler
    }

    private var refreshTask: Task<TokenPair, Error>?

    public init(
        baseURL: URL,
        session: URLSession = .init(configuration: {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 30
            return config
        }()),
        tokenStore: SecureTokenStore = KeychainStore()
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenStore = tokenStore
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = APIClient.isoWithFraction.date(from: value) { return date }
            if let date = APIClient.iso.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognized date format: \(value)")
        }
        self.decoder = decoder
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
    }

    // ISO8601DateFormatter isn't Sendable, but these are configured once here and only ever
    // read (via `.date(from:)`) afterward — safe to share across the decoder's call sites.
    nonisolated(unsafe) private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    // MARK: - Public request surface

    public func request<Response: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil,
        authorized: Bool = true
    ) async throws -> Response {
        let data = try await requestData(method, path, query: query, body: body, authorized: authorized, retrying: false)
        do {
            return try decoder.decode(Envelope<Response>.self, from: data).unwrapped
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// For endpoints that return no body (e.g. `POST /leads/:id/notes`).
    public func requestVoid(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil
    ) async throws {
        _ = try await requestData(method, path, query: query, body: body, authorized: true, retrying: false)
    }

    /// Multipart/form-data upload (e.g. `POST /recruitment/jobs/:id/resumes/batch`) — the one request
    /// shape `request(_:_:body:)` can't express, since its body is always JSON-encoded. Shares the same
    /// Bearer-auth/401-refresh-retry/envelope-unwrap behavior as `request(_:_:)`, just with a differently
    /// built body and Content-Type.
    public func uploadMultipart<Response: Decodable>(
        _ path: String,
        files: [MultipartFile],
        fieldName: String = "files"
    ) async throws -> Response {
        let data = try await uploadMultipartData(path, files: files, fieldName: fieldName, retrying: false)
        do {
            return try decoder.decode(Envelope<Response>.self, from: data).unwrapped
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func uploadMultipartData(
        _ path: String,
        files: [MultipartFile],
        fieldName: String,
        retrying: Bool
    ) async throws -> Data {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        for file in files {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(file.filename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(file.mimeType)\r\n\r\n".data(using: .utf8)!)
            body.append(file.data)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token = try? tokenStore.read(for: "accessToken") {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body

        let (responseData, response): (Data, URLResponse)
        do {
            (responseData, response) = try await session.data(for: request)
        } catch let urlError as URLError where urlError.code == .timedOut {
            throw APIError.timeout
        } catch let urlError as URLError {
            throw APIError.network(urlError.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        switch http.statusCode {
        case 200...299:
            return responseData
        case 401:
            if !retrying, let refreshed = try? await refreshTokens() {
                try? tokenStore.save(refreshed.accessToken, for: "accessToken")
                try? tokenStore.save(refreshed.refreshToken, for: "refreshToken")
                return try await uploadMultipartData(path, files: files, fieldName: fieldName, retrying: true)
            }
            let errorBody = decodeError(responseData)
            onSessionExpired?()
            throw APIError.unauthorized(errorBody)
        case 403:
            throw APIError.forbidden(decodeError(responseData))
        case 404:
            throw APIError.notFound(decodeError(responseData))
        default:
            throw APIError.server(status: http.statusCode, body: decodeError(responseData))
        }
    }

    // MARK: - Core

    private func requestData(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem],
        body: (any Encodable)?,
        authorized: Bool,
        retrying: Bool
    ) async throws -> Data {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw APIError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized, let token = try? tokenStore.read(for: "accessToken") {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(AnyEncodable(body))
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch let urlError as URLError where urlError.code == .timedOut {
            throw APIError.timeout
        } catch let urlError as URLError where urlError.code == .cancelled {
            throw APIError.cancelled
        } catch let urlError as URLError {
            throw APIError.network(urlError.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }

        switch http.statusCode {
        case 200...299:
            return data
        case 401:
            if authorized, !retrying, let refreshed = try? await refreshTokens() {
                try? tokenStore.save(refreshed.accessToken, for: "accessToken")
                try? tokenStore.save(refreshed.refreshToken, for: "refreshToken")
                return try await requestData(method, path, query: query, body: body, authorized: authorized, retrying: true)
            }
            let errorBody = decodeError(data)
            onSessionExpired?()
            throw APIError.unauthorized(errorBody)
        case 403:
            throw APIError.forbidden(decodeError(data))
        case 404:
            throw APIError.notFound(decodeError(data))
        default:
            throw APIError.server(status: http.statusCode, body: decodeError(data))
        }
    }

    private func decodeError(_ data: Data) -> APIErrorBody? {
        try? decoder.decode(APIErrorEnvelope.self, from: data).error
    }

    /// Coalesces concurrent refresh attempts into a single in-flight `POST /auth/refresh` call.
    private func refreshTokens() async throws -> TokenPair {
        if let existing = refreshTask {
            return try await existing.value
        }
        let task = Task<TokenPair, Error> {
            guard let refreshToken = try? tokenStore.read(for: "refreshToken") else {
                throw APIError.unauthorized(nil)
            }
            let data = try await requestData(
                .post,
                "/auth/refresh",
                query: [],
                body: RefreshRequest(refreshToken: refreshToken),
                authorized: false,
                retrying: true
            )
            return try decoder.decode(Envelope<AuthenticationResult>.self, from: data).unwrapped.tokens
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }
}

/// The backend's `{ "data": ... }` response envelope (auth endpoints). Leads endpoints return the raw
/// object with no envelope — `unwrapped` handles both by falling back to decoding the top-level value.
private struct Envelope<T: Decodable>: Decodable {
    let unwrapped: T

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: DynamicKey.self),
           container.contains(DynamicKey(stringValue: "data")!) {
            let nested = try container.decode(T.self, forKey: DynamicKey(stringValue: "data")!)
            unwrapped = nested
        } else {
            unwrapped = try T(from: decoder)
        }
    }
}

private struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Type-erasing wrapper so `request(_:_:body:)` can accept any `Encodable` value.
private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init(_ wrapped: any Encodable) {
        encodeClosure = { encoder in try wrapped.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeClosure(encoder) }
}
