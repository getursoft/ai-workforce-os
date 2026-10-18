import SwiftUI
import KreviaCore

struct AppShellView: View {
    @EnvironmentObject private var dependencies: AppDependencies

    var body: some View {
        TabView {
            HomeView(dependencies: dependencies)
                .tabItem { Label("Home", systemImage: "house.fill") }

            CRMTabRootView(dependencies: dependencies)
                .tabItem { Label("Krevia CRM", systemImage: "person.crop.rectangle.stack.fill") }

            ConversationsTabRootView(dependencies: dependencies)
                .tabItem { Label("Conversations", systemImage: "message.fill") }

            UsageTabRootView(dependencies: dependencies)
                .tabItem { Label("Usage", systemImage: "chart.bar.fill") }
        }
        .tint(KreviaTheme.primary)
    }
}
