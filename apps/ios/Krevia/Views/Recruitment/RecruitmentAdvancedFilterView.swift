import SwiftUI
import KreviaCore

/// Sprint 7.17 (Phase 2) — the native iOS counterpart to the website's Advanced Filter Panel, built on
/// the SAME shared /recruitment/candidates/search endpoint. Reached from the job-detail screen's toolbar
/// rather than replacing the existing simple candidate list there.
struct RecruitmentAdvancedFilterView: View {
    @StateObject private var viewModel: RecruitmentCandidateFilterViewModel
    @EnvironmentObject private var dependencies: AppDependencies
    @State private var showFilters = true
    @State private var showingExportShare = false
    @State private var exportURL: URL?

    init(jobId: String?, dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: RecruitmentCandidateFilterViewModel(
            service: dependencies.recruitmentService, jobId: jobId
        ))
    }

    var body: some View {
        List {
            if showFilters { filterSection }
            resultsHeader
            ForEach(viewModel.items) { application in
                NavigationLink(value: application) {
                    candidateRow(application)
                }
            }
            if viewModel.hasMore {
                loadMoreRow
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Advanced Filters")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: RecruitmentApplication.self) { application in
            RecruitmentCandidateDetailView(application: application, dependencies: dependencies)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(showFilters ? "Hide Filters" : "Filters") { showFilters.toggle() }
            }
        }
        .refreshable { await viewModel.applyFilters() }
        .sheet(isPresented: $showingExportShare) {
            if let exportURL { ShareLink(item: exportURL) { Label("Share Export", systemImage: "square.and.arrow.up") }.padding() }
        }
        .alert("Export", isPresented: Binding(
            get: { viewModel.exportNotice != nil && exportURL == nil },
            set: { if !$0 { } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.exportNotice ?? "")
        }
    }

    private var filterSection: some View {
        Section("Filters") {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(KreviaTheme.muted)
                TextField("Search candidate name, phone, email…", text: $viewModel.searchText)
            }
            HStack {
                TextField("Min score", text: $viewModel.scoreMin).keyboardType(.numberPad)
                TextField("Max score", text: $viewModel.scoreMax).keyboardType(.numberPad)
            }
            TextField("City (comma-separated)", text: $viewModel.currentCity)
            TextField("State (comma-separated)", text: $viewModel.currentState)
            TextField("Region (e.g. Delhi NCR)", text: $viewModel.region)
            HStack {
                TextField("Min experience (yrs)", text: $viewModel.minExperience).keyboardType(.numberPad)
                TextField("Max experience (yrs)", text: $viewModel.maxExperience).keyboardType(.numberPad)
            }
            TextField("Required skills (comma-separated)", text: $viewModel.requiredSkills)
            Picker("Sort by", selection: $viewModel.sortBy) {
                ForEach(viewModel.sortOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            HStack {
                Button("Apply Filters") { Task { await viewModel.applyFilters() } }
                    .buttonStyle(.borderedProminent)
                Button("Clear") { viewModel.clearFilters() }
                    .buttonStyle(.bordered)
            }
            if let error = viewModel.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private var resultsHeader: some View {
        Section {
            HStack {
                Text("\(viewModel.totalCount) matching candidates").font(.subheadline).foregroundStyle(KreviaTheme.muted)
                Spacer()
                if !viewModel.selectedIds.isEmpty {
                    Button("Export Selected (\(viewModel.selectedIds.count))") {
                        Task { await runExportAndShare { await viewModel.exportResults() } }
                    }
                    .font(.caption)
                } else if viewModel.hasActiveFilters {
                    Button("Export Filtered") {
                        Task { await runExportAndShare { await viewModel.exportResults() } }
                    }
                    .font(.caption)
                }
            }
            if viewModel.isLoading { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    private func candidateRow(_ application: RecruitmentApplication) -> some View {
        HStack {
            Button {
                viewModel.toggleSelection(application.id)
            } label: {
                Image(systemName: viewModel.selectedIds.contains(application.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(viewModel.selectedIds.contains(application.id) ? KreviaTheme.primary : KreviaTheme.muted)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(application.candidate.fullName ?? "Not Available").font(.subheadline.weight(.semibold))
                Text([application.candidate.currentCity, "\(application.resume.relevantExperienceYears ?? 0) yrs"].compactMap { $0 }.joined(separator: " • "))
                    .font(.caption).foregroundStyle(KreviaTheme.muted)
            }
            Spacer()
            if let score = application.evaluation?.matchScore {
                Text("\(Int(score))%").font(.subheadline.weight(.bold)).foregroundStyle(KreviaTheme.primary)
            }
        }
    }

    /// Sprint 7.17 (Phase 3) — large exports are now actually drained by a background worker, so a
    /// `nil` immediate result (status QUEUED) is followed by a real poll rather than leaving the
    /// recruiter with nothing but a "check back later" notice.
    private func runExportAndShare(_ request: () async -> URL?) async {
        if let url = await request() {
            exportURL = url
            showingExportShare = true
            return
        }
        guard viewModel.queuedExportJobId != nil else { return }
        if let url = await viewModel.pollExportUntilDone() {
            exportURL = url
            showingExportShare = true
        }
    }

    private var loadMoreRow: some View {
        HStack {
            Spacer()
            if viewModel.isLoadingMore {
                ProgressView()
            } else {
                Button("Load More") { Task { await viewModel.loadMore() } }
                    .font(.caption)
            }
            Spacer()
        }
    }
}
