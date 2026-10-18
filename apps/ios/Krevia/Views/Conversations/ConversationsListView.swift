import SwiftUI
import KreviaCore

/// Conversations content — no internal `NavigationStack`, same convention as `EmployeesListView`.
struct ConversationsListView: View {
    @StateObject private var viewModel: ConversationsListViewModel
    private let dependencies: AppDependencies

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: ConversationsListViewModel(conversationService: dependencies.conversationService))
    }

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Conversations")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    statusFilterMenu
                }
            }
            .task { if viewModel.interactions.isEmpty { await viewModel.load() } }
    }

    private var statusFilterMenu: some View {
        Menu {
            Button("All") { select(nil) }
            ForEach([InteractionStatus.open, .active, .waiting, .completed, .failed, .cancelled], id: \.self) { status in
                Button(status.displayName) { select(status) }
            }
        } label: {
            Label(viewModel.statusFilter?.displayName ?? "All", systemImage: "line.3.horizontal.decrease.circle")
        }
    }

    private func select(_ status: InteractionStatus?) {
        viewModel.statusFilter = status
        Task { await viewModel.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.interactions.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.interactions.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            EmptyConversationsView()
        default:
            List(viewModel.interactions) { interaction in
                NavigationLink {
                    ConversationDetailView(interactionId: interaction.id, dependencies: dependencies)
                } label: {
                    ConversationRow(interaction: interaction)
                }
                .listRowBackground(KreviaTheme.surface)
                .listRowSeparator(.hidden)
                .task { await viewModel.loadMoreIfNeeded(current: interaction) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(KreviaTheme.background)
            .refreshable { await viewModel.refresh() }
        }
    }
}

private struct ConversationRow: View {
    let interaction: InteractionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(interaction.channel.displayName, systemImage: interaction.channel.systemImage)
                    .font(.headline)
                Spacer()
                InteractionStatusBadge(status: interaction.status)
            }
            if let contact = interaction.phoneNumber ?? interaction.email {
                Text(contact).font(.subheadline).foregroundStyle(.secondary)
            }
            if let summary = interaction.resolutionSummary, !summary.isEmpty {
                Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(interaction.lastActivityAt, style: .relative)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct InteractionStatusBadge: View {
    let status: InteractionStatus

    var tone: Color {
        switch status {
        case .open, .active: return KreviaTheme.success
        case .waiting: return KreviaTheme.warning
        case .completed: return .secondary
        case .failed, .cancelled: return KreviaTheme.danger
        }
    }

    var body: some View {
        Text(status.displayName)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tone.opacity(0.15))
            .foregroundStyle(tone)
            .clipShape(Capsule())
            .accessibilityLabel("Status: \(status.displayName)")
    }
}

private struct EmptyConversationsView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(.secondary)
            Text("No conversations yet").font(.headline)
            Text("Conversations your AI Employees have with customers will show up here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// Tab-root wrapper — the ONLY place a `NavigationStack` is created for the Conversations tab.
struct ConversationsTabRootView: View {
    let dependencies: AppDependencies
    var body: some View {
        NavigationStack {
            ConversationsListView(dependencies: dependencies)
        }
    }
}
