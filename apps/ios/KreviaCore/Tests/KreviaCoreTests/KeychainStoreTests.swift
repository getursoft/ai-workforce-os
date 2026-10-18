import XCTest
@testable import KreviaCore

final class KeychainStoreTests: XCTestCase {
    // Uses InMemoryTokenStore (same protocol the real KeychainStore implements) so this suite never
    // depends on a Keychain access group / entitlement being available in the test runner.
    func testSaveAndReadRoundTrip() throws {
        let store = InMemoryTokenStore()
        try store.save("secret-token", for: "accessToken")
        XCTAssertEqual(try store.read(for: "accessToken"), "secret-token")
    }

    func testReadMissingKeyReturnsNil() throws {
        let store = InMemoryTokenStore()
        XCTAssertNil(try store.read(for: "missing"))
    }

    func testDeleteRemovesValue() throws {
        let store = InMemoryTokenStore()
        try store.save("secret-token", for: "accessToken")
        try store.delete(for: "accessToken")
        XCTAssertNil(try store.read(for: "accessToken"))
    }

    func testOverwriteReplacesValue() throws {
        let store = InMemoryTokenStore()
        try store.save("first", for: "accessToken")
        try store.save("second", for: "accessToken")
        XCTAssertEqual(try store.read(for: "accessToken"), "second")
    }
}
