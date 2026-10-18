import SwiftUI
import KreviaCore

/// Usage content — no internal `NavigationStack` (Tab root wraps it via `UsageTabRootView`).
struct UsageView: View {
    @StateObject private var viewModel: UsageViewModel
    private let dependencies: AppDependencies
    @State private var showingRecharge = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: UsageViewModel(billingService: dependencies.billingService))
    }

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Usage")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    NavigationLink { WalletView(dependencies: dependencies) } label: {
                        Label("Wallet", systemImage: "wallet.bifold")
                    }
                }
            }
            .sheet(isPresented: $showingRecharge) {
                RechargeView(dependencies: dependencies) {
                    Task { await viewModel.load() }
                }
            }
            .task { if viewModel.summary == nil { await viewModel.load() } }
            .onChange(of: viewModel.period) { _ in Task { await viewModel.load() } }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.summary == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.summary == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Period", selection: $viewModel.period) {
                        ForEach(UsagePeriod.allCases) { period in
                            Text(period.rawValue).tag(period)
                        }
                    }
                    .pickerStyle(.segmented)

                    if let summary = viewModel.summary {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                            MetricTile(title: "Remaining Credits", value: "\(summary.remainingCredits)", icon: "creditcard.fill", color: KreviaTheme.primary)
                            MetricTile(title: "Used Credits", value: "\(summary.usedCredits)", icon: "bolt.fill", color: KreviaTheme.warning)
                            MetricTile(title: "Requests", value: "\(summary.totalRequests)", icon: "arrow.left.arrow.right")
                            MetricTile(title: "Total Tokens", value: "\(summary.tokens.total)", icon: "cpu")
                        }
                    }

                    Button {
                        showingRecharge = true
                    } label: {
                        HStack {
                            Image(systemName: "creditcard.fill")
                            Text("Recharge Credits").fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding()
                        .background(KreviaTheme.primary)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }

                    if !viewModel.byEmployee.isEmpty {
                        UsageSection(title: "By AI Employee") {
                            ForEach(viewModel.byEmployee) { row in
                                UsageBar(label: row.employeeName, credits: row.creditsConsumed, share: row.sharePercentage)
                            }
                        }
                    }

                    if !viewModel.byModel.isEmpty {
                        UsageSection(title: "By Model / Provider") {
                            ForEach(viewModel.byModel) { row in
                                UsageBar(label: "\(row.provider) · \(row.model)", credits: row.creditsConsumed, share: nil)
                            }
                        }
                    }
                }
                .padding()
            }
            .refreshable { await viewModel.load() }
        }
    }
}

private struct UsageSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            VStack(spacing: 10) { content }
        }
        .kreviaCard()
    }
}

private struct UsageBar: View {
    let label: String
    let credits: Int
    let share: Double?

    var body: some View {
        HStack {
            Text(label).font(.subheadline).lineLimit(1)
            Spacer()
            if let share {
                Text("\(share, specifier: "%.0f")%").font(.caption).foregroundStyle(.secondary)
            }
            Text("\(credits) cr").font(.caption.weight(.semibold))
        }
    }
}

/// Tab-root wrapper — the ONLY place a `NavigationStack` is created for the Usage tab.
struct UsageTabRootView: View {
    let dependencies: AppDependencies
    var body: some View {
        NavigationStack {
            UsageView(dependencies: dependencies)
        }
    }
}
