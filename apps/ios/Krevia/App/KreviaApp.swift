import SwiftUI
import KreviaCore

@main
struct KreviaApp: App {
    @StateObject private var dependencies = AppDependencies()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(dependencies)
                .environmentObject(dependencies.session)
                .task { await dependencies.restoreSessionIfPossible() }
        }
    }
}
