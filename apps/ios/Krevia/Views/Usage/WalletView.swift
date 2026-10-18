import SwiftUI
import KreviaCore

struct WalletView: View {
    @StateObject private var viewModel: WalletViewModel
    private let dependencies: AppDependencies
    @State private var showingRecharge = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: WalletViewModel(billingService: dependencies.billingService))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle("Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .task { await viewModel.load() }
            .refreshable { await viewModel.load() }
            .sheet(isPresented: $showingRecharge) {
                RechargeView(dependencies: dependencies) {
                    Task { await viewModel.load() }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.summary == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.summary == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else if let summary = viewModel.summary {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        MetricTile(title: "Available Credits", value: "\(summary.remainingCredits)", color: KreviaTheme.primary)
                        MetricTile(title: "Purchased Credits", value: "\(viewModel.purchasedCredits)", color: KreviaTheme.success)
                        MetricTile(title: "Consumed Credits", value: "\(summary.usedCredits)", color: KreviaTheme.warning)
                        if let plan = summary.plan {
                            MetricTile(title: "Plan", value: plan.name)
                        }
                    }

                    Button {
                        showingRecharge = true
                    } label: {
                        HStack {
                            Image(systemName: "creditcard.fill")
                            Text("Recharge Credits").fontWeight(.semibold)
                            Spacer()
                        }
                        .padding()
                        .background(KreviaTheme.primary)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    NavigationLink {
                        TransactionsView(dependencies: dependencies)
                    } label: {
                        HStack {
                            Image(systemName: "list.bullet.rectangle")
                            Text("Transaction History").fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding()
                        .kreviaCard()
                    }
                    .buttonStyle(.plain)
                }
                .padding()
            }
        }
    }
}
