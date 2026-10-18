import SwiftUI
import KreviaCore

struct LeadDetailView: View {
    @StateObject private var viewModel: LeadDetailViewModel
    @State private var assignUserId: String = ""
    @State private var showingAssignSheet = false
    @State private var pendingStatus: LeadStatus?

    init(leadId: String, dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: LeadDetailViewModel(leadId: leadId, leadService: dependencies.leadService))
    }

    var body: some View {
        ScrollView {
            if viewModel.isLoading && viewModel.lead == nil {
                ProgressView().padding(.top, 80)
            } else if let message = viewModel.errorMessage, viewModel.lead == nil {
                RetryStateView(message: message) { Task { await viewModel.load() } }
            } else if let lead = viewModel.lead {
                VStack(alignment: .leading, spacing: 16) {
                    header(lead)
                    summaryCard(lead)
                    actionsCard(lead)
                    notesCard
                    activityCard
                }
                .padding()
            }
        }
        .background(KreviaTheme.background)
        .navigationTitle("Lead")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await viewModel.load() }
        .task { await viewModel.load() }
        .confirmationDialog(
            "Change status to \(pendingStatus?.displayName ?? "")?",
            isPresented: Binding(get: { pendingStatus != nil }, set: { if !$0 { pendingStatus = nil } }),
            titleVisibility: .visible
        ) {
            Button("Confirm") {
                if let status = pendingStatus { Task { await viewModel.updateStatus(status) } }
                pendingStatus = nil
            }
            Button("Cancel", role: .cancel) { pendingStatus = nil }
        }
        .sheet(isPresented: $showingAssignSheet) {
            assignSheet
        }
    }

    private func header(_ lead: Lead) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(lead.leadReferenceId).font(.headline)
                Spacer()
                StatusBadge(status: lead.status)
            }
            Text(lead.name ?? "Unnamed lead").font(.title2.bold())
        }
    }

    private func summaryCard(_ lead: Lead) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            detailRow("Phone", lead.phone)
            detailRow("Email", lead.email)
            detailRow("Requirement", lead.requirement)
            detailRow("Source", lead.source.displayName)
            detailRow("AI Employee", lead.agentId)
            detailRow("Priority", lead.priority.rawValue)
            detailRow("Assigned To", lead.assignedToUserId)
            detailRow("Interaction", lead.interactionId)
            detailRow("Created", lead.createdAt.formatted(date: .abbreviated, time: .shortened))
            detailRow("Last Activity", lead.lastActivityAt.formatted(date: .abbreviated, time: .shortened))
        }
        .kreviaCard()
    }

    private func detailRow(_ title: String, _ value: String?) -> some View {
        HStack(alignment: .top) {
            Text(title).font(.caption).foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
            Text(value?.isEmpty == false ? value! : "—").font(.subheadline)
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value?.isEmpty == false ? value! : "not set")")
    }

    private func actionsCard(_ lead: Lead) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Actions").font(.subheadline.weight(.semibold))

            Text("Status").font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(LeadStatus.allCases) { status in
                        Button {
                            pendingStatus = status
                        } label: {
                            Text(status.displayName)
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(status == lead.status ? KreviaTheme.primary : Color(uiColor: .secondarySystemBackground))
                                .foregroundStyle(status == lead.status ? .white : .primary)
                                .clipShape(Capsule())
                        }
                        .disabled(viewModel.isMutating || status == lead.status)
                    }
                }
            }

            Button {
                assignUserId = lead.assignedToUserId ?? ""
                showingAssignSheet = true
            } label: {
                Label("Assign", systemImage: "person.crop.circle.badge.plus")
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isMutating)
        }
        .kreviaCard()
    }

    private var notesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Add Note").font(.subheadline.weight(.semibold))
            TextEditor(text: $viewModel.noteText)
                .frame(height: 80)
                .padding(6)
                .background(Color(uiColor: .tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("New note")
            Button("Add Note") { Task { await viewModel.addNote() } }
                .buttonStyle(.borderedProminent)
                .tint(KreviaTheme.primary)
                .disabled(viewModel.isMutating || viewModel.noteText.trimmingCharacters(in: .whitespaces).isEmpty)
            if let error = viewModel.errorMessage {
                Text(error).font(.caption).foregroundStyle(KreviaTheme.danger)
            }
        }
        .kreviaCard()
    }

    private var activityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Activity").font(.subheadline.weight(.semibold))
            if viewModel.activity.isEmpty {
                Text("No activity yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.activity) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(entry.type.displayName).font(.caption.weight(.semibold))
                            Spacer()
                            Text(entry.createdAt.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        if let note = entry.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    Divider()
                }
            }
        }
        .kreviaCard()
    }

    private var assignSheet: some View {
        NavigationStack {
            Form {
                Section("Assign to user ID") {
                    TextField("User ID", text: $assignUserId)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                }
                if let error = viewModel.errorMessage {
                    Text(error).foregroundStyle(KreviaTheme.danger)
                }
            }
            .navigationTitle("Assign Lead")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showingAssignSheet = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await viewModel.assign(to: assignUserId.isEmpty ? nil : assignUserId)
                            showingAssignSheet = false
                        }
                    }
                }
            }
        }
    }
}
