import Foundation

/// Single composition point wiring the API client, services, and the auth session together —
/// avoids re-creating URLSession/token stores per screen.
@MainActor
public final class AppDependencies: ObservableObject {
    public let session: AuthSession
    public let client: APIClient
    public let authService: AuthService
    public let leadService: LeadService
    public let billingService: BillingService
    public let conversationService: ConversationService
    public let pluginService: PluginService
    public let roleService: RoleService
    public let organizationService: OrganizationService
    public let agentService: AgentService
    public let recruitmentService: RecruitmentService

    public init(baseURL: URL = AppConfig.shared.baseURL) {
        let tokenStore = KeychainStore()
        let session = AuthSession(tokenStore: tokenStore)
        let client = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.session = session
        self.client = client
        self.authService = AuthService(client: client)
        self.leadService = LeadService(client: client)
        self.billingService = BillingService(client: client)
        self.conversationService = ConversationService(client: client)
        self.pluginService = PluginService(client: client)
        self.roleService = RoleService(client: client)
        self.organizationService = OrganizationService(client: client)
        self.agentService = AgentService(client: client)
        self.recruitmentService = RecruitmentService(client: client)
        Task {
            await client.setSessionExpiredHandler { [weak session] in
                Task { @MainActor in session?.clear() }
            }
        }
    }

    /// Best-effort rehydration of the current user/org on launch when a token already exists.
    public func restoreSessionIfPossible() async {
        guard session.isAuthenticated else { return }
        do {
            let me = try await authService.me()
            session.updateProfile(me)
        } catch let error as APIError where error.isUnauthorized {
            session.clear()
        } catch {
            // Network hiccup on launch — keep the locally cached auth state; screens will retry.
        }
    }

    public func logout() async {
        if let refreshToken = session.refreshToken {
            try? await authService.logout(refreshToken: refreshToken)
        }
        session.clear()
    }
}
