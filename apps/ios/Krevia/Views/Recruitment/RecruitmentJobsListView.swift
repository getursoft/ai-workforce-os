import SwiftUI
import KreviaCore

/// AI Recruitment Consultant — internal only (not reachable via AI Receptionist, never shown in any
/// customer-facing catalog). Full parity with the website: job creation and resume upload are both
/// implemented, not deferred.
struct RecruitmentJobsListView: View {
    @StateObject private var viewModel: RecruitmentJobsViewModel
    private let dependencies: AppDependencies
    @State private var showingCreateJob = false

    init(dependencies: AppDependencies) {
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: RecruitmentJobsViewModel(service: dependencies.recruitmentService))
    }

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        content
            .kreviaScreen()
            .navigationTitle("Recruitment")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingCreateJob = true } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .accessibilityLabel("Create Job")
                }
            }
            .sheet(isPresented: $showingCreateJob) {
                CreateJobView(dependencies: dependencies) {
                    Task { await viewModel.refresh() }
                }
            }
            .task { if viewModel.jobs.isEmpty { await viewModel.load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch (viewModel.isLoading, viewModel.errorMessage, viewModel.isEmpty) {
        case (true, _, _) where viewModel.jobs.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case (_, .some(let message), _) where viewModel.jobs.isEmpty:
            RetryStateView(message: message) { Task { await viewModel.load() } }
        case (_, _, true):
            VStack(spacing: 10) {
                Image(systemName: "person.text.rectangle").font(.largeTitle).foregroundStyle(KreviaTheme.muted)
                Text("No job openings yet").font(.headline)
                Text("Create a job opening to start matching candidates.")
                    .font(.subheadline)
                    .foregroundStyle(KreviaTheme.muted)
                    .multilineTextAlignment(.center)
                Button("Create Job") { showingCreateJob = true }
                    .buttonStyle(.borderedProminent)
                    .tint(KreviaTheme.primary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        default:
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(viewModel.jobs) { job in
                        NavigationLink {
                            RecruitmentJobDetailView(jobId: job.id, dependencies: dependencies)
                        } label: {
                            JobCard(job: job)
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

private struct JobCard: View {
    let job: RecruitmentJob

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.text.rectangle.fill")
                .font(.title3)
                .foregroundStyle(KreviaTheme.danger)
                .frame(width: 44, height: 44)
                .background(KreviaTheme.danger.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(spacing: 2) {
                Text(job.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(KreviaTheme.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                Text(job.jobCode)
                    .font(.caption2)
                    .foregroundStyle(KreviaTheme.muted)
            }
            HStack(spacing: 12) {
                Label("\(job.totalResumes)", systemImage: "doc.text")
                Label("\(job.aiRecommendedCount)", systemImage: "checkmark.seal")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(KreviaTheme.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .kreviaCard()
    }
}
