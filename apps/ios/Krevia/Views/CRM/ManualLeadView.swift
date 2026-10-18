import SwiftUI
import KreviaCore

struct ManualLeadView: View {
    @StateObject private var viewModel: ManualLeadViewModel
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void

    init(dependencies: AppDependencies, onCreated: @escaping () -> Void = {}) {
        _viewModel = StateObject(wrappedValue: ManualLeadViewModel(leadService: dependencies.leadService))
        self.onCreated = onCreated
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Customer") {
                    TextField("Name", text: $viewModel.name)
                    TextField("Phone", text: $viewModel.phone).keyboardType(.phonePad)
                    TextField("Email", text: $viewModel.email).keyboardType(.emailAddress).autocapitalization(.none)
                }
                Section("Requirement") {
                    TextField("What do they need?", text: $viewModel.requirement, axis: .vertical)
                        .lineLimit(3...6)
                }
                Section("Priority") {
                    Picker("Priority", selection: $viewModel.priority) {
                        ForEach(LeadPriority.allCases) { priority in
                            Text(priority.rawValue.capitalized).tag(priority)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                if let error = viewModel.errorMessage {
                    Text(error).foregroundStyle(KreviaTheme.danger)
                }
            }
            .navigationTitle("New Lead")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if viewModel.isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await viewModel.submit() } }
                            .disabled(!viewModel.canSubmit)
                    }
                }
            }
            .onChange(of: viewModel.createdLead) { newValue in
                if newValue != nil {
                    onCreated()
                    dismiss()
                }
            }
        }
    }
}
