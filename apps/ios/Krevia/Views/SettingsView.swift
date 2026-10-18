import SwiftUI
import KreviaCore

struct SettingsView: View {
    @EnvironmentObject private var session: AuthSession
    let dependencies: AppDependencies
    @State private var showingLogoutConfirmation = false
    @State private var isLoggingOut = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if let user = session.currentUser {
                        LabeledContent("Name", value: "\(user.firstName) \(user.lastName ?? "")")
                        LabeledContent("Email", value: user.email)
                        LabeledContent("Role", value: user.role)
                    }
                    if let org = session.currentOrganization {
                        LabeledContent("Organization", value: org.name)
                    }
                }
                Section("API") {
                    LabeledContent("Environment", value: AppConfig.shared.environment.rawValue.capitalized)
                    LabeledContent("Base URL", value: AppConfig.shared.baseURL.absoluteString)
                }
                Section {
                    Button(role: .destructive) {
                        showingLogoutConfirmation = true
                    } label: {
                        if isLoggingOut {
                            ProgressView()
                        } else {
                            Text("Log Out")
                        }
                    }
                    .disabled(isLoggingOut)
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Log out of Krevia?", isPresented: $showingLogoutConfirmation, titleVisibility: .visible) {
                Button("Log Out", role: .destructive) {
                    isLoggingOut = true
                    Task {
                        await dependencies.logout()
                        isLoggingOut = false
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}
