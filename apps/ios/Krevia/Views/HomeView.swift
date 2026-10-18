import SwiftUI
import KreviaCore

/// Home is a pure navigation hub — icon + name cards matching the dashboard sidebar's nav items
/// (same labels, same icons, same brand colors). No duplicate stat numbers here: usage/credit figures
/// live only on the Usage screen, not scattered across Home as well.
struct HomeView: View {
    @EnvironmentObject private var session: AuthSession
    private let dependencies: AppDependencies
    @State private var showingSettings = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
    }

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header

                    LazyVGrid(columns: columns, spacing: 12) {
                        NavigationLink {
                            EmployeesListView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "AI Employees", icon: "person.2.fill", tint: KreviaTheme.success)
                        }
                        NavigationLink {
                            LeadListView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Krevia CRM", icon: "person.crop.rectangle.stack.fill", tint: KreviaTheme.accentStrong)
                        }
                        NavigationLink {
                            ConversationsListView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Conversations", icon: "message.fill", tint: KreviaTheme.statBlue)
                        }
                        NavigationLink {
                            UsageView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Usage & Billing", icon: "chart.bar.fill", tint: KreviaTheme.statPurple)
                        }
                        NavigationLink {
                            RolesListView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Roles", icon: "checkmark.shield.fill", tint: KreviaTheme.danger)
                        }
                        NavigationLink {
                            OrganizationSettingsView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Organization", icon: "building.2.fill", tint: KreviaTheme.primary)
                        }
                        NavigationLink {
                            RecruitmentJobsListView(dependencies: dependencies)
                        } label: {
                            NavCard(title: "Recruitment", icon: "person.text.rectangle.fill", tint: KreviaTheme.warning)
                        }
                        Button { showingSettings = true } label: {
                            NavCard(title: "Settings", icon: "gearshape.fill", tint: KreviaTheme.muted)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .padding()
                .padding(.bottom, 24)
            }
            .background(KreviaTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Krevia").font(.headline.weight(.bold)).foregroundStyle(KreviaTheme.primary)
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView(dependencies: dependencies)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            InitialsAvatar(text: session.currentUser?.firstName ?? "K")
            VStack(alignment: .leading, spacing: 2) {
                Text("Welcome\(session.currentUser.map { ", \($0.firstName)" } ?? "")")
                    .font(.title3.bold())
                    .foregroundStyle(KreviaTheme.ink)
                if let org = session.currentOrganization {
                    Text(org.name).font(.subheadline).foregroundStyle(KreviaTheme.muted)
                }
            }
            Spacer()
        }
        .padding(16)
        .background(
            LinearGradient(colors: [KreviaTheme.primary.opacity(0.12), KreviaTheme.primary.opacity(0.04)], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

struct RetryStateView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.title).foregroundStyle(KreviaTheme.muted)
            Text(message).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(KreviaTheme.muted)
            Button("Retry", action: retry)
                .buttonStyle(.borderedProminent)
                .tint(KreviaTheme.primary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
        .padding()
    }
}
