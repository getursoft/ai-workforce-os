import SwiftUI
import KreviaCore

struct ConversationDetailView: View {
    @StateObject private var viewModel: ConversationDetailViewModel

    init(interactionId: String, dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: ConversationDetailViewModel(
            interactionId: interactionId,
            conversationService: dependencies.conversationService
        ))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle(viewModel.interaction?.referenceId ?? "Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .task { await viewModel.load() }
            .refreshable { await viewModel.load() }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.interaction == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.interaction == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else if let interaction = viewModel.interaction {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(interaction.channel.displayName, systemImage: interaction.channel.systemImage)
                                .font(.title3.bold())
                            Text(interaction.referenceId).font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        InteractionStatusBadge(status: interaction.status)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Details").font(.headline)
                        DetailRow(title: "Started", value: interaction.startedAt.formatted(date: .abbreviated, time: .shortened))
                        DetailRow(title: "Last Activity", value: interaction.lastActivityAt.formatted(date: .abbreviated, time: .shortened))
                        if let completedAt = interaction.completedAt {
                            DetailRow(title: "Completed", value: completedAt.formatted(date: .abbreviated, time: .shortened))
                        }
                        if let contact = interaction.phoneNumber {
                            DetailRow(title: "Phone", value: contact)
                        }
                        if let contact = interaction.email {
                            DetailRow(title: "Email", value: contact)
                        }
                        if let agentId = interaction.currentAgentId {
                            DetailRow(title: "Current Agent", value: agentId)
                        }
                    }
                    .kreviaCard()

                    if let summary = interaction.resolutionSummary, !summary.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Resolution Summary").font(.headline)
                            Text(summary).font(.subheadline).foregroundStyle(.secondary)
                        }
                        .kreviaCard()
                    }
                }
                .padding()
            }
        }
    }
}

private struct DetailRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.subheadline.weight(.medium)).multilineTextAlignment(.trailing)
        }
    }
}
