import SwiftUI
import KreviaCore

struct TransactionsView: View {
    @StateObject private var viewModel: TransactionsViewModel

    init(dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: TransactionsViewModel(billingService: dependencies.billingService))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle("Transactions")
            .navigationBarTitleDisplayMode(.inline)
            .task { if viewModel.transactions.isEmpty { await viewModel.load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.transactions.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.transactions.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            EmptyTransactionsView()
        default:
            List(viewModel.transactions) { transaction in
                TransactionRow(transaction: transaction)
                    .listRowBackground(KreviaTheme.surface)
                    .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(KreviaTheme.background)
            .refreshable { await viewModel.load() }
        }
    }
}

private struct TransactionRow: View {
    let transaction: BillingTransaction

    private var deltaColor: Color {
        transaction.creditsDelta >= 0 ? KreviaTheme.success : KreviaTheme.danger
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(transaction.typeLabel).font(.subheadline.weight(.medium))
                Text(transaction.reference).font(.caption).foregroundStyle(.secondary)
                Text(transaction.date.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(transaction.creditsDelta > 0 ? "+" : "")\(transaction.creditsDelta)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(deltaColor)
                Text(transaction.statusLabel).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct EmptyTransactionsView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "list.bullet.rectangle").font(.largeTitle).foregroundStyle(.secondary)
            Text("No transactions yet").font(.headline)
            Text("Recharges and usage debits will appear here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
