import SwiftUI
import KreviaCore

/// Employees content — no internal `NavigationStack` (pushed from Home), same convention as
/// `LeadListView`. Rendered as a card grid (not a list) to match the dashboard's AI Employees page
/// and the rest of the app's card-based navigation.
struct EmployeesListView: View {
    @StateObject private var viewModel: EmployeesListViewModel
    private let dependencies: AppDependencies

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: EmployeesListViewModel(billingService: dependencies.billingService))
    }

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Employees")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        EmployeeCatalogView(dependencies: dependencies) {
                            Task { await viewModel.refresh() }
                        }
                    } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .accessibilityLabel("Browse AI Employees")
                }
            }
            .task { if viewModel.employees.isEmpty { await viewModel.load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.employees.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.employees.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            EmptyEmployeesView(dependencies: dependencies) {
                Task { await viewModel.refresh() }
            }
        default:
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(viewModel.employees) { employee in
                        NavigationLink {
                            EmployeeDetailView(employeeId: employee.pluginInstallationId, dependencies: dependencies)
                        } label: {
                            EmployeeCard(employee: employee)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
            .background(KreviaTheme.background)
            .refreshable { await viewModel.refresh() }
        }
    }
}

private struct EmployeeCard: View {
    let employee: EmployeeOverview

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 8) {
                Image(systemName: "cpu")
                    .font(.title3)
                    .foregroundStyle(employee.active ? KreviaTheme.success : KreviaTheme.muted)
                    .frame(width: 44, height: 44)
                    .background((employee.active ? KreviaTheme.success : KreviaTheme.muted).opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(spacing: 2) {
                    Text(employee.name)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(KreviaTheme.ink)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                    Text(employee.type)
                        .font(.caption2)
                        .foregroundStyle(KreviaTheme.muted)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                }
                HStack(spacing: 12) {
                    statPair(value: employee.conversations, icon: "message.fill")
                    statPair(value: employee.creditsConsumed, icon: "bolt.fill")
                }
            }
            .frame(maxWidth: .infinity)
            ActiveBadge(active: employee.active)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .kreviaCard()
        .accessibilityElement(children: .combine)
    }

    private func statPair(value: Int, icon: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 9))
            Text("\(value)").font(.caption2.weight(.semibold))
        }
        .foregroundStyle(KreviaTheme.muted)
    }
}

struct ActiveBadge: View {
    let active: Bool
    var body: some View {
        Text(active ? "Active" : "Inactive")
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background((active ? KreviaTheme.success : KreviaTheme.muted).opacity(0.15))
            .foregroundStyle(active ? KreviaTheme.success : KreviaTheme.muted)
            .clipShape(Capsule())
            .accessibilityLabel(active ? "Active" : "Inactive")
    }
}

private struct EmptyEmployeesView: View {
    let dependencies: AppDependencies
    let onInstalled: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.2.slash").font(.largeTitle).foregroundStyle(KreviaTheme.muted)
            Text("No AI Employees yet").font(.headline)
            Text("Browse the catalog and install your first AI Employee.")
                .font(.subheadline)
                .foregroundStyle(KreviaTheme.muted)
                .multilineTextAlignment(.center)
            NavigationLink {
                EmployeeCatalogView(dependencies: dependencies, onInstalled: onInstalled)
            } label: {
                Text("Browse AI Employees").fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent)
            .tint(KreviaTheme.primary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
