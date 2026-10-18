import SwiftUI
import KreviaCore

/// Recharge workflow: pick a real published package → create a real, server-tracked PENDING order.
/// Stops there — the app has no payment-checkout SDK integrated (no gateway is configured for this
/// workspace), so it never simulates or claims a successful payment. A real checkout provider (Razorpay)
/// would be launched from the "Awaiting Payment" state below with the order's `gatewayOrderId`/`razorpayKeyId`;
/// completion is always confirmed server-side via `BillingService.verifyOrder`, never assumed on-device.
struct RechargeView: View {
    @StateObject private var viewModel: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    let onOrderCreated: () -> Void

    init(dependencies: AppDependencies, onOrderCreated: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: WalletViewModel(billingService: dependencies.billingService))
        self.onOrderCreated = onOrderCreated
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Recharge Credits")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Close") { dismiss() }
                    }
                }
                .task { await viewModel.load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let order = viewModel.pendingOrder {
            PendingOrderView(order: order)
        } else if viewModel.isLoading && viewModel.packages.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.packages.isEmpty {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else {
            List {
                if let rechargeError = viewModel.rechargeErrorMessage {
                    Section {
                        Text(rechargeError).foregroundStyle(KreviaTheme.danger)
                    }
                }
                Section("Choose a credit package") {
                    ForEach(viewModel.packages) { package in
                        Button {
                            Task {
                                await viewModel.startRecharge(credits: package.credits)
                                if viewModel.pendingOrder != nil { onOrderCreated() }
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text("\(package.credits) credits").font(.headline)
                                    Text(formattedAmount(package))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if viewModel.isStartingRecharge {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(viewModel.isStartingRecharge)
                    }
                }
            }
        }
    }

    private func formattedAmount(_ package: CreditPackage) -> String {
        let amount = Double(package.amountMinor) / 100
        return amount.formatted(.currency(code: package.currency))
    }
}

private struct PendingOrderView: View {
    let order: CreditPurchaseOrderView

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.checkmark").font(.system(size: 44)).foregroundStyle(KreviaTheme.warning)
            Text("Order Created — Awaiting Payment").font(.title3.bold())
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Reference", value: order.id)
                LabeledContent("Credits", value: "\(order.credits)")
                LabeledContent("Status", value: order.status)
            }
            .kreviaCard()
            Text("Checkout would launch here through the workspace's configured payment provider. Credits are only added once the payment is verified on the server — never before.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
