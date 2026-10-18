import Foundation
import Security

/// Minimal, testable Keychain abstraction. Tokens are NEVER stored in UserDefaults and NEVER logged.
public protocol SecureTokenStore: Sendable {
    func save(_ value: String, for key: String) throws
    func read(for key: String) throws -> String?
    func delete(for key: String) throws
}

public enum KeychainError: Error, Equatable {
    case unhandled(OSStatus)
    case encodingFailed
}

/// Real device/simulator Keychain-backed implementation.
public final class KeychainStore: SecureTokenStore, @unchecked Sendable {
    private let service: String

    public init(service: String = "in.krevia.ios.auth") {
        self.service = service
    }

    public func save(_ value: String, for key: String) throws {
        guard let data = value.data(using: .utf8) else { throw KeychainError.encodingFailed }
        var query = baseQuery(for: key)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let attributesToUpdate: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery(for: key) as CFDictionary, attributesToUpdate as CFDictionary)
        if updateStatus == errSecItemNotFound {
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unhandled(addStatus) }
        } else if updateStatus != errSecSuccess {
            throw KeychainError.unhandled(updateStatus)
        }
    }

    public func read(for key: String) throws -> String? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.unhandled(status)
        }
        return String(data: data, encoding: .utf8)
    }

    public func delete(for key: String) throws {
        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandled(status)
        }
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}

/// In-memory implementation for unit tests — no Keychain entitlement required to run `swift test`.
public final class InMemoryTokenStore: SecureTokenStore, @unchecked Sendable {
    private var storage: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func save(_ value: String, for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = value
    }

    public func read(for key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return storage[key]
    }

    public func delete(for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage.removeValue(forKey: key)
    }
}
