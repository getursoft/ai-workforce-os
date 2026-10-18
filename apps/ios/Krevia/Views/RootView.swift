import SwiftUI
import KreviaCore

struct RootView: View {
    @EnvironmentObject private var dependencies: AppDependencies
    @EnvironmentObject private var session: AuthSession

    var body: some View {
        Group {
            if session.isAuthenticated {
                AppShellView()
            } else {
                LoginView(dependencies: dependencies)
            }
        }
        .animation(.default, value: session.isAuthenticated)
    }
}
