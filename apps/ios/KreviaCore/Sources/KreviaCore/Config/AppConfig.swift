import Foundation

/// Configurable API base URL. Never hardcode secrets here — only the endpoint host.
public enum AppEnvironment: String, CaseIterable, Sendable {
    case development
    case production

    /// Simulator-compatible localhost endpoint for the existing Krevia API (`apps/api`, global prefix `api/v1`).
    public var defaultBaseURL: URL {
        switch self {
        case .development:
            return URL(string: "http://localhost:4000/api/v1")!
        case .production:
            return URL(string: "https://api.krevia.in/api/v1")!
        }
    }
}

public final class AppConfig: @unchecked Sendable {
    public static let shared = AppConfig()

    private let defaults: UserDefaults
    private let baseURLKey = "krevia.apiBaseURL"
    private let environmentKey = "krevia.environment"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var environment: AppEnvironment {
        get {
            defaults.string(forKey: environmentKey).flatMap(AppEnvironment.init(rawValue:))
                ?? (isDebugBuild ? .development : .production)
        }
        set { defaults.set(newValue.rawValue, forKey: environmentKey) }
    }

    /// Base URL, e.g. `http://localhost:4000/api/v1` or `https://api.krevia.in/api/v1`.
    /// Production must be HTTPS — enforced defensively even if a bad value is stored.
    public var baseURL: URL {
        get {
            if let stored = defaults.string(forKey: baseURLKey), let url = URL(string: stored) {
                if environment == .production, url.scheme != "https" {
                    return environment.defaultBaseURL
                }
                return url
            }
            return environment.defaultBaseURL
        }
        set { defaults.set(newValue.absoluteString, forKey: baseURLKey) }
    }

    private var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
