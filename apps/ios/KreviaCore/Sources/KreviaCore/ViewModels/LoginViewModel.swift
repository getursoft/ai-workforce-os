import Foundation

@MainActor
public final class LoginViewModel: ObservableObject {
    @Published public var organizationName: String = ""
    @Published public var email: String = ""
    @Published public var password: String = ""
    @Published public private(set) var isLoading: Bool = false
    @Published public var errorMessage: String?

    private let authService: AuthService
    private let session: AuthSession

    public init(authService: AuthService, session: AuthSession) {
        self.authService = authService
        self.session = session
    }

    public var canSubmit: Bool {
        !organizationName.trimmingCharacters(in: .whitespaces).isEmpty
            && !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isLoading
    }

    public func login() async {
        guard canSubmit else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await authService.login(
                email: email.trimmingCharacters(in: .whitespaces),
                password: password,
                organizationName: organizationName.trimmingCharacters(in: .whitespaces)
            )
            try session.store(authentication: result)
            password = ""
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Unable to sign in. Please try again."
        }
    }
}
