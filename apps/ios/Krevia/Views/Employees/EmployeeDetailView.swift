import SwiftUI
import KreviaCore

struct EmployeeDetailView: View {
    @StateObject private var viewModel: EmployeeDetailViewModel
    @Environment(\.dismiss) private var dismiss
    private let dependencies: AppDependencies
    private let employeeId: String
    @State private var showingUninstallConfirmation = false

    init(employeeId: String, dependencies: AppDependencies) {
        self.employeeId = employeeId
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: EmployeeDetailViewModel(
            employeeId: employeeId, billingService: dependencies.billingService, pluginService: dependencies.pluginService
        ))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle(viewModel.detail?.name ?? "Employee")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if viewModel.detail != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(role: .destructive) {
                            showingUninstallConfirmation = true
                        } label: {
                            Image(systemName: "trash")
                        }
                        .accessibilityLabel("Uninstall")
                        .disabled(viewModel.isUninstalling)
                    }
                }
            }
            .confirmationDialog(
                "Uninstall \(viewModel.detail?.name ?? "this AI Employee")?",
                isPresented: $showingUninstallConfirmation,
                titleVisibility: .visible
            ) {
                Button("Uninstall", role: .destructive) {
                    Task {
                        if await viewModel.uninstall() { dismiss() }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes the employee and stops it from running. This can't be undone.")
            }
            .alert("Couldn't uninstall", isPresented: Binding(
                get: { viewModel.uninstallError != nil },
                set: { if !$0 { viewModel.uninstallError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.uninstallError ?? "")
            }
            .task { await viewModel.load() }
            .refreshable { await viewModel.load() }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.detail == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.detail == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else if let detail = viewModel.detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(detail.name).font(.title2.bold()).foregroundStyle(KreviaTheme.ink)
                            Text(detail.type).font(.subheadline).foregroundStyle(KreviaTheme.muted)
                        }
                        Spacer()
                        ActiveBadge(active: detail.active)
                    }

                    NavigationLink {
                        EmployeeChatView(employeeId: employeeId, employeeName: detail.name, dependencies: dependencies)
                    } label: {
                        HStack {
                            Image(systemName: "message.fill")
                            Text("Start Conversation").fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding()
                        .background(KreviaTheme.primary)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .disabled(!detail.active)
                    .opacity(detail.active ? 1 : 0.5)

                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        MetricTile(title: "Today", value: "\(detail.usageToday.creditsConsumed) cr")
                        MetricTile(title: "7 Days", value: "\(detail.usageWeek.creditsConsumed) cr")
                        MetricTile(title: "30 Days", value: "\(detail.usageMonth.creditsConsumed) cr")
                    }
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        MetricTile(title: "Leads Generated", value: "\(detail.leadsGenerated)", color: KreviaTheme.primary)
                        MetricTile(title: "Conversations", value: "\(detail.conversations)", color: KreviaTheme.muted)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Recent Activity").font(.headline).foregroundStyle(KreviaTheme.ink)
                        if detail.recentActivity.isEmpty {
                            Text("No recent activity.").font(.subheadline).foregroundStyle(KreviaTheme.muted)
                        } else {
                            ForEach(detail.recentActivity) { event in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(event.status).font(.subheadline.weight(.medium)).foregroundStyle(KreviaTheme.ink)
                                        Text(event.occurredAt.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption).foregroundStyle(KreviaTheme.muted)
                                    }
                                    Spacer()
                                    Text("\(event.creditsConsumed) cr").font(.caption.weight(.semibold)).foregroundStyle(KreviaTheme.muted)
                                }
                                .padding(.vertical, 4)
                                Divider()
                            }
                        }
                    }
                    .kreviaCard()
                }
                .padding()
            }
        } else {
            // Defensive: covers the brief instant before `.task` sets isLoading, so this screen is
            // never a true blank white page even for a single frame.
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
