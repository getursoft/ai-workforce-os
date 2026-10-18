import SwiftUI
import KreviaCore

struct CreateJobView: View {
    @StateObject private var viewModel: CreateJobViewModel
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void

    init(dependencies: AppDependencies, onCreated: @escaping () -> Void = {}) {
        _viewModel = StateObject(wrappedValue: CreateJobViewModel(service: dependencies.recruitmentService))
        self.onCreated = onCreated
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Job") {
                    TextField("Job Title", text: $viewModel.title)
                    TextField("Job Description", text: $viewModel.description, axis: .vertical)
                        .lineLimit(5...10)
                    Button {
                        Task { await viewModel.suggestCriteria() }
                    } label: {
                        if viewModel.isParsingDescription {
                            ProgressView()
                        } else {
                            Text("Suggest criteria from description")
                        }
                    }
                    .disabled(viewModel.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isParsingDescription)
                    if let error = viewModel.parseError {
                        Text(error).font(.caption).foregroundStyle(KreviaTheme.danger)
                    }
                }
                Section("Required Skills") {
                    TextField("Mandatory Skills (comma-separated)", text: $viewModel.mandatorySkills, axis: .vertical)
                    TextField("Preferred Skills (comma-separated)", text: $viewModel.preferredSkills, axis: .vertical)
                    TextField("Certifications (comma-separated)", text: $viewModel.certifications, axis: .vertical)
                }
                Section("Experience") {
                    HStack {
                        TextField("Min years", text: $viewModel.minExperienceYears)
                            .keyboardType(.numberPad)
                        Divider()
                        TextField("Max years", text: $viewModel.maxExperienceYears)
                            .keyboardType(.numberPad)
                    }
                }
                Section("Details") {
                    TextField("Department", text: $viewModel.department)
                    TextField("Location", text: $viewModel.location)
                    TextField("Hiring Manager", text: $viewModel.hiringManager)
                    TextField("Number of Openings", text: $viewModel.numberOfOpenings)
                        .keyboardType(.numberPad)
                }
                if let error = viewModel.createError {
                    Text(error).foregroundStyle(KreviaTheme.danger)
                }
            }
            .navigationTitle("Create Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if viewModel.isCreating {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await viewModel.create() } }
                            .disabled(!viewModel.canCreate)
                    }
                }
            }
            .onChange(of: viewModel.createdJob) { newValue in
                if newValue != nil {
                    onCreated()
                    dismiss()
                }
            }
        }
    }
}
