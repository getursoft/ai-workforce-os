import SwiftUI
import KreviaCore

/// Maps 1:1 to the dashboard's Roles admin page (`GET/POST /roles`).
struct RolesListView: View {
    @StateObject private var viewModel: RolesListViewModel
    private let dependencies: AppDependencies
    @State private var showingNewRole = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: RolesListViewModel(roleService: dependencies.roleService))
    }

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Roles")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingNewRole = true } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .accessibilityLabel("New role")
                }
            }
            .sheet(isPresented: $showingNewRole) {
                NewRoleView(viewModel: viewModel)
            }
            .task { if viewModel.roles.isEmpty { await viewModel.load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.roles.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.roles.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            VStack(spacing: 10) {
                Image(systemName: "shield.lefthalf.filled").font(.largeTitle).foregroundStyle(KreviaTheme.muted)
                Text("No roles yet").font(.headline)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        default:
            List(viewModel.roles) { role in
                RoleRow(role: role)
                    .listRowBackground(KreviaTheme.surface)
                    .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(KreviaTheme.background)
            .refreshable { await viewModel.refresh() }
        }
    }
}

private struct RoleRow: View {
    let role: OrgRole

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(role.name).font(.headline).foregroundStyle(KreviaTheme.ink)
                Spacer()
                if role.isSystem {
                    Text("System")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(KreviaTheme.muted.opacity(0.15))
                        .foregroundStyle(KreviaTheme.muted)
                        .clipShape(Capsule())
                }
            }
            if let description = role.description, !description.isEmpty {
                Text(description).font(.subheadline).foregroundStyle(KreviaTheme.muted)
            }
            HStack(spacing: 12) {
                Label("\(role.permissions.count) permissions", systemImage: "lock.fill")
                if let userCount = role.count?.users {
                    Label("\(userCount) users", systemImage: "person.fill")
                }
            }
            .font(.caption2)
            .foregroundStyle(KreviaTheme.muted)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct NewRoleView: View {
    @ObservedObject var viewModel: RolesListViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Role") {
                    TextField("Name", text: $name)
                    TextField("Description (optional)", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                }
                if let error = viewModel.createError {
                    Text(error).foregroundStyle(KreviaTheme.danger)
                }
            }
            .navigationTitle("New Role")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if viewModel.isCreating {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task {
                                let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                                let trimmedDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
                                if await viewModel.createRole(
                                    name: trimmedName,
                                    description: trimmedDescription.isEmpty ? nil : trimmedDescription
                                ) {
                                    dismiss()
                                }
                            }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }
}
