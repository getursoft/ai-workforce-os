import SwiftUI
import KreviaCore

/// Browse every discoverable AI Employee plugin and install one — maps 1:1 to the dashboard's
/// AI Employees catalog (`GET /plugins/available`, `POST /plugins/install`). Card grid, not a list,
/// matching the rest of the app.
struct EmployeeCatalogView: View {
    @StateObject private var viewModel: EmployeeCatalogViewModel
    var onInstalled: (() -> Void)?

    init(dependencies: AppDependencies, onInstalled: (() -> Void)? = nil) {
        _viewModel = StateObject(wrappedValue: EmployeeCatalogViewModel(pluginService: dependencies.pluginService))
        self.onInstalled = onInstalled
    }

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Browse AI Employees")
            .navigationBarTitleDisplayMode(.inline)
            .task { if viewModel.items.isEmpty { await viewModel.load() } }
            .refreshable { await viewModel.load() }
            .alert("Couldn't install", isPresented: Binding(
                get: { viewModel.installError != nil },
                set: { if !$0 { viewModel.installError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.installError ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.items.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.items.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            VStack(spacing: 10) {
                Image(systemName: "shippingbox").font(.largeTitle).foregroundStyle(KreviaTheme.muted)
                Text("No AI Employees available").font(.headline)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        default:
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(viewModel.items.count) available")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(KreviaTheme.muted)
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(viewModel.items) { item in
                            CatalogCard(
                                item: item,
                                isInstalling: viewModel.installingId == item.id
                            ) {
                                Task {
                                    await viewModel.install(item)
                                    if viewModel.installError == nil { onInstalled?() }
                                }
                            }
                        }
                    }
                }
                .padding()
                .padding(.bottom, 24)
            }
            .background(KreviaTheme.background)
        }
    }
}

/// Icon per plugin id — mirrors the dashboard sidebar's `ADMIN_ITEMS` icon choices exactly
/// (apps/dashboard dashboard-shell.tsx), so the same employee reads the same way in both apps.
private func catalogIcon(for id: String) -> String {
    switch id {
    case "sales-employee": return "chart.line.uptrend.xyaxis"
    case "marketing-employee": return "megaphone.fill"
    case "hr-employee": return "person.text.rectangle.fill"
    case "finance-employee": return "wallet.bifold.fill"
    case "it-support-employee": return "headphones"
    case "legal-employee": return "scalemass.fill"
    case "customer-support-employee": return "lifepreserver.fill"
    case "travel-employee": return "airplane"
    case "receptionist-employee": return "person.wave.2.fill"
    default: return "cpu"
    }
}

private struct CatalogCard: View {
    let item: PluginCatalogItem
    let isInstalling: Bool
    let install: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if item.installed {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(KreviaTheme.success)
            }
            VStack(spacing: 10) {
                Image(systemName: catalogIcon(for: item.id))
                    .font(.title3)
                    .foregroundStyle(KreviaTheme.primary)
                    .frame(width: 44, height: 44)
                    .background(KreviaTheme.primary.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(spacing: 2) {
                    Text(item.displayName)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(KreviaTheme.ink)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                    if let description = item.description, !description.isEmpty {
                        Text(description)
                            .font(.caption2)
                            .foregroundStyle(KreviaTheme.muted)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                installControl
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, minHeight: 190)
        .kreviaCard()
    }

    @ViewBuilder
    private var installControl: some View {
        if item.installed {
            Text("Installed")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(KreviaTheme.success)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(KreviaTheme.success.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else if isInstalling {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        } else {
            Button(action: install) {
                Text("Install")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(KreviaTheme.primary)
        }
    }
}
