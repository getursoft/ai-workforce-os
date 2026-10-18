import SwiftUI
import UniformTypeIdentifiers
import KreviaCore

struct RecruitmentJobDetailView: View {
    @StateObject private var viewModel: RecruitmentJobDetailViewModel
    @State private var showingFileImporter = false
    private let jobId: String
    private let dependencies: AppDependencies

    init(jobId: String, dependencies: AppDependencies) {
        self.jobId = jobId
        self.dependencies = dependencies
        _viewModel = StateObject(wrappedValue: RecruitmentJobDetailViewModel(jobId: jobId, service: dependencies.recruitmentService))
    }

    var body: some View {
        content
            .background(KreviaTheme.background)
            .navigationTitle(viewModel.job?.title ?? "Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if viewModel.job != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingFileImporter = true
                        } label: {
                            if viewModel.isUploading {
                                ProgressView()
                            } else {
                                Image(systemName: "doc.badge.plus")
                            }
                        }
                        .accessibilityLabel("Upload Resumes")
                        .disabled(viewModel.isUploading)
                    }
                    // Sprint 7.17 Phase 2 — additive entry point to the new advanced filter screen;
                    // the existing simple candidate list below is untouched.
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink {
                            RecruitmentAdvancedFilterView(jobId: jobId, dependencies: dependencies)
                        } label: {
                            Image(systemName: "line.3.horizontal.decrease.circle")
                        }
                        .accessibilityLabel("Advanced Filters")
                    }
                }
            }
            // Native document selection: PDF and DOCX, multiple files at once (Phase 3/9's "bulk resume
            // upload" and "native document selection APIs").
            .fileImporter(
                isPresented: $showingFileImporter,
                allowedContentTypes: [.pdf, UTType(filenameExtension: "docx") ?? .data],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    Task { await uploadPickedFiles(urls) }
                case .failure:
                    viewModel.uploadError = "Couldn't read the selected files. Please try again."
                }
            }
            .alert("Upload failed", isPresented: Binding(
                get: { viewModel.uploadError != nil },
                set: { if !$0 { viewModel.uploadError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.uploadError ?? "")
            }
            .task { await viewModel.load() }
            .refreshable { await viewModel.load() }
    }

    /// Reads each picked file's bytes (security-scoped, since these come from outside the app sandbox via
    /// the system document picker) and hands them to the view model as one batch upload.
    private func uploadPickedFiles(_ urls: [URL]) async {
        var files: [MultipartFile] = []
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mimeType = url.pathExtension.lowercased() == "docx"
                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                : "application/pdf"
            files.append(MultipartFile(filename: url.lastPathComponent, mimeType: mimeType, data: data))
        }
        await viewModel.uploadResumes(files)
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.job == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let message = viewModel.errorMessage, viewModel.job == nil {
            RetryStateView(message: message) { Task { await viewModel.load() } }
        } else if let job = viewModel.job {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(job.title).font(.title2.bold()).foregroundStyle(KreviaTheme.ink)
                        Text(job.jobCode).font(.subheadline).foregroundStyle(KreviaTheme.muted)
                    }

                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        MetricTile(title: "Total Resumes", value: "\(job.totalResumes)")
                        MetricTile(title: "AI-Recommended", value: "\(job.aiRecommendedCount)", color: KreviaTheme.success)
                        MetricTile(title: "Shortlisted", value: "\(job.recruiterShortlistedCount)", color: KreviaTheme.primary)
                    }

                    if let batch = viewModel.batchStatus {
                        BatchStatusBanner(status: batch)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Candidates").font(.headline).foregroundStyle(KreviaTheme.ink)
                        if viewModel.candidates.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("No candidates yet. Upload resumes to start matching.")
                                    .font(.subheadline).foregroundStyle(KreviaTheme.muted)
                                Button("Upload Resumes") { showingFileImporter = true }
                                    .buttonStyle(.borderedProminent)
                                    .tint(KreviaTheme.primary)
                            }
                        } else {
                            ForEach(viewModel.candidates) { application in
                                CandidateRow(
                                    application: application,
                                    isReviewing: viewModel.isReviewing == application.id
                                ) { decision in
                                    Task { await viewModel.review(application, decision: decision) }
                                }
                                Divider()
                            }
                        }
                    }
                    .kreviaCard()
                }
                .padding()
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct BatchStatusBanner: View {
    let status: RecruitmentBatchStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Processing resumes").font(.subheadline.weight(.semibold)).foregroundStyle(KreviaTheme.ink)
                Spacer()
                Text(status.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption.weight(.semibold)).foregroundStyle(KreviaTheme.muted)
            }
            HStack(spacing: 14) {
                Label("\(status.completed) done", systemImage: "checkmark.circle")
                Label("\(status.processing) processing", systemImage: "arrow.triangle.2.circlepath")
                Label("\(status.failed) failed", systemImage: "exclamationmark.circle")
                Label("\(status.queued) queued", systemImage: "clock")
            }
            .font(.caption2)
            .foregroundStyle(KreviaTheme.muted)
        }
        .kreviaCard()
    }
}

private struct CandidateRow: View {
    let application: RecruitmentApplication
    let isReviewing: Bool
    let onDecision: (String) -> Void

    private var scoreText: String {
        if let score = application.evaluation?.matchScore, application.evaluation?.evaluationStatus == "COMPLETED" {
            return "\(Int(score))%"
        }
        if application.resume.parsingStatus == "FAILED" { return "Parsing failed" }
        return "Processing…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(application.candidate.fullName ?? "Not Available")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(KreviaTheme.ink)
                    Text(application.candidate.mobileNumber ?? "Not Available")
                        .font(.caption).foregroundStyle(KreviaTheme.muted)
                }
                Spacer()
                Text(scoreText).font(.subheadline.weight(.bold)).foregroundStyle(KreviaTheme.primary)
            }
            if isReviewing {
                ProgressView()
            } else {
                Menu {
                    ForEach(["PENDING_REVIEW", "SHORTLISTED", "NOT_SELECTED", "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED", "ON_HOLD", "HIRED"], id: \.self) { decision in
                        Button(decision.replacingOccurrences(of: "_", with: " ").capitalized) { onDecision(decision) }
                    }
                } label: {
                    Label(
                        application.recruiterDecision.replacingOccurrences(of: "_", with: " ").capitalized,
                        systemImage: "chevron.up.chevron.down"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(KreviaTheme.muted)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
