import SwiftUI
import KreviaCore

/// Maps 1:1 to the dashboard's Organization settings page
/// (`GET/PATCH /organizations/me`, `GET/PATCH /organizations/me/settings`).
struct OrganizationSettingsView: View {
    @StateObject private var viewModel: OrganizationSettingsViewModel
    @State private var name = ""
    @State private var timezone = ""
    @State private var currency = ""
    @State private var locale = ""

    init(dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: OrganizationSettingsViewModel(organizationService: dependencies.organizationService))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle("Organization")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if viewModel.organization == nil { await viewModel.load() }
            }
            .onChange(of: viewModel.organization) { org in
                if let org { name = org.name }
            }
            .onChange(of: viewModel.settings) { settings in
                if let settings {
                    timezone = settings.timezone
                    currency = settings.currency
                    locale = settings.locale
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.organization == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.organization == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else if let organization = viewModel.organization {
            Form {
                Section("Organization") {
                    TextField("Name", text: $name)
                    LabeledContent("Slug", value: organization.slug)
                    LabeledContent("Status", value: organization.status.capitalized)
                }
                Section("Regional Settings") {
                    TextField("Timezone", text: $timezone)
                    TextField("Currency", text: $currency)
                    TextField("Locale", text: $locale)
                }
                if let error = viewModel.saveError {
                    Text(error).foregroundStyle(KreviaTheme.danger)
                }
                Section {
                    Button {
                        Task { await viewModel.save(name: name, timezone: timezone, currency: currency, locale: locale) }
                    } label: {
                        if viewModel.isSaving {
                            ProgressView()
                        } else {
                            Text("Save Changes").fontWeight(.semibold)
                        }
                    }
                    .disabled(viewModel.isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if viewModel.saveSucceeded {
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(KreviaTheme.success)
                    }
                }
            }
        } else {
            // Defensive: covers the brief instant before `.task` sets isLoading, so this screen is
            // never a true blank white page even for a single frame.
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
