import SwiftUI
import KreviaCore

/// Lead list content — deliberately owns no `NavigationStack` of its own so it can be used both as a
/// Tab root (wrapped once by `CRMTabRootView`) and pushed from Home (inheriting Home's own stack).
struct LeadListView: View {
    @StateObject private var viewModel: LeadListViewModel
    private let dependencies: AppDependencies
    @State private var showingManualLead = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: LeadListViewModel(leadService: dependencies.leadService))
    }

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Krevia CRM")
            .searchable(text: $viewModel.searchText, prompt: "Search leads")
            .onChange(of: viewModel.searchText) { _ in viewModel.onSearchTextChanged() }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showingManualLead = true } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .accessibilityLabel("Add manual lead")
                }
            }
            .sheet(isPresented: $showingManualLead) {
                ManualLeadView(dependencies: dependencies) {
                    Task { await viewModel.refresh() }
                }
            }
            .task { if viewModel.leads.isEmpty { await viewModel.loadFirstPage() } }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 0) {
            filterBar
            switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
            case (true, _, _) where viewModel.leads.isEmpty:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case (_, .some(let message), _) where viewModel.leads.isEmpty:
                RetryStateView(message: message) { Task { await viewModel.loadFirstPage() } }
            case (_, _, true):
                EmptyLeadsView()
            default:
                List {
                    ForEach(viewModel.leads) { lead in
                        NavigationLink {
                            LeadDetailView(leadId: lead.id, dependencies: dependencies)
                        } label: {
                            LeadRow(lead: lead)
                        }
                        .listRowBackground(KreviaTheme.surface)
                        .listRowSeparator(.hidden)
                        .task { await viewModel.loadNextPageIfNeeded(currentItem: lead) }
                    }
                    if viewModel.isLoadingMore {
                        ProgressView().frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(KreviaTheme.background)
                .refreshable { await viewModel.refresh() }
            }
        }
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    Button("All statuses") { viewModel.statusFilter = nil; Task { await viewModel.applyFilters() } }
                    ForEach(LeadStatus.allCases) { status in
                        Button(status.displayName) { viewModel.statusFilter = status; Task { await viewModel.applyFilters() } }
                    }
                } label: {
                    FilterChip(title: viewModel.statusFilter?.displayName ?? "Status")
                }
                Menu {
                    Button("All sources") { viewModel.sourceFilter = nil; Task { await viewModel.applyFilters() } }
                    ForEach(LeadSource.allCases) { source in
                        Button(source.displayName) { viewModel.sourceFilter = source; Task { await viewModel.applyFilters() } }
                    }
                } label: {
                    FilterChip(title: viewModel.sourceFilter?.displayName ?? "Source")
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }
}

private struct FilterChip: View {
    let title: String
    var body: some View {
        HStack(spacing: 4) {
            Text(title)
            Image(systemName: "chevron.down")
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(Capsule())
    }
}

private struct LeadRow: View {
    let lead: Lead

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(lead.leadReferenceId).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                StatusBadge(status: lead.status)
            }
            Text(lead.name ?? "Unnamed lead").font(.headline)
            if let requirement = lead.requirement, !requirement.isEmpty {
                Text(requirement).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 12) {
                Label(lead.source.displayName, systemImage: "antenna.radiowaves.left.and.right")
                Label(lead.createdAt.formatted(date: .abbreviated, time: .omitted), systemImage: "calendar")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct EmptyLeadsView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            Text("No leads yet").font(.headline)
            Text("Leads captured by your AI workforce, or added manually, will appear here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// Tab-root wrapper — the ONLY place a `NavigationStack` is created for the CRM tab.
struct CRMTabRootView: View {
    let dependencies: AppDependencies
    var body: some View {
        NavigationStack {
            LeadListView(dependencies: dependencies)
        }
    }
}
