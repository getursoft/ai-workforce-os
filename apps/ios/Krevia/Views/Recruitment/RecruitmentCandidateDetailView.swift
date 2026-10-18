import SwiftUI
import KreviaCore

/// Sprint 7.17 (Phase 2/5). Contact info is masked unless the live-fetched permission check passes —
/// never assumed from local role state. The call action requires an explicit tap (Phase 5: "Do not
/// initiate a call automatically without a user gesture") and only opens the system's own native phone
/// UI via `tel:` — this app never dials or connects a call itself.
struct RecruitmentCandidateDetailView: View {
    @StateObject private var viewModel: RecruitmentCandidateDetailViewModel
    @State private var showingExportShare = false
    @State private var exportURL: URL?
    @State private var showingCallConfirmation = false
    @State private var callError: String?

    init(application: RecruitmentApplication, dependencies: AppDependencies) {
        _viewModel = StateObject(wrappedValue: RecruitmentCandidateDetailViewModel(
            application: application, service: dependencies.recruitmentService, authService: dependencies.authService
        ))
    }

    private var application: RecruitmentApplication { viewModel.application }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(application.candidate.fullName ?? "Not Available").font(.title2.bold()).foregroundStyle(KreviaTheme.ink)
                    Text(application.resume.resumeCode).font(.subheadline).foregroundStyle(KreviaTheme.muted)
                }

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    MetricTile(title: "ATS Score", value: scoreText, color: KreviaTheme.primary)
                    MetricTile(title: "Relevant Experience", value: "\(application.resume.relevantExperienceYears ?? 0) yrs")
                }

                section("Location") {
                    row("Current", locationText)
                    row("Preferred", (application.candidate.preferredWorkLocations?.isEmpty == false) ? application.candidate.preferredWorkLocations!.joined(separator: ", ") : "Not specified")
                    row("Willing to relocate", relocateText)
                    row("Notice period", application.candidate.noticePeriod ?? "Not specified")
                }

                section("Skills") {
                    row("Matched", application.evaluation?.matchedSkills?.joined(separator: ", ") ?? "None")
                    row("Missing", application.evaluation?.missingSkills?.joined(separator: ", ") ?? "None")
                }

                section("Status") {
                    row("AI Recommendation", application.aiRecommendation ?? "Pending")
                    row("Recruiter Decision", application.recruiterDecision.replacingOccurrences(of: "_", with: " ").capitalized)
                }

                section("Contact") {
                    if viewModel.isLoadingPermissions {
                        ProgressView()
                    } else if viewModel.canSeeContact {
                        if let phone = application.candidate.mobileNumber {
                            if viewModel.canCall && isDialableNumber(phone) {
                                Button {
                                    showingCallConfirmation = true
                                } label: {
                                    Label(phone, systemImage: "phone.fill")
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(KreviaTheme.primary)
                                .confirmationDialog("Call \(application.candidate.fullName ?? "this candidate")?", isPresented: $showingCallConfirmation, titleVisibility: .visible) {
                                    Button("Call \(phone)") {
                                        Task {
                                            await viewModel.logCallLinkOpened()
                                            // Opening the native dialer is NOT proof a call was placed or
                                            // connected — only that the recruiter's device was handed the
                                            // number (Phase 5: "Opening a phone dialer is not proof").
                                            if let url = dialableURL(for: phone) {
                                                await UIApplication.shared.open(url)
                                            } else {
                                                callError = "This number couldn't be opened in the Phone app."
                                            }
                                        }
                                    }
                                    Button("Cancel", role: .cancel) { Task { await viewModel.logCallCancelled() } }
                                }
                            } else if viewModel.canCall {
                                Text("Phone: \(phone) (not in a dialable format)").foregroundStyle(KreviaTheme.muted)
                            } else {
                                // Contact permission without calling permission: the number is visible
                                // (Phase 5 allows this split) but no tap-to-call action is offered.
                                Text("Phone: \(phone)").foregroundStyle(KreviaTheme.ink)
                            }
                        } else {
                            Text("Phone: Not Available").foregroundStyle(KreviaTheme.muted)
                        }
                        row("Email", application.candidate.email ?? "Not Available")
                    } else {
                        Text("Contact details are hidden — you don't have candidate-contact permission.")
                            .font(.subheadline).foregroundStyle(KreviaTheme.muted)
                    }
                    if let callError {
                        Text(callError).font(.caption).foregroundStyle(.red)
                    }
                }

                Button {
                    Task {
                        if let url = await viewModel.exportResultsSingle() {
                            exportURL = url
                            showingExportShare = true
                        }
                    }
                } label: {
                    Label("Export This Candidate", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
        .background(KreviaTheme.background)
        .navigationTitle("Candidate")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.loadPermissions() }
        .sheet(isPresented: $showingExportShare) {
            if let exportURL { ShareLink(item: exportURL) { Label("Share Export", systemImage: "square.and.arrow.up") }.padding() }
        }
    }

    /// A minimal, local sanity check (not a substitute for the server's own libphonenumber-based
    /// validation) — just enough to avoid offering a call action for a value that is obviously not a
    /// phone number (e.g. too short, or no digits at all).
    private func isDialableNumber(_ raw: String) -> Bool {
        let digits = raw.filter(\.isNumber)
        return digits.count >= 7
    }

    private func dialableURL(for raw: String) -> URL? {
        let filtered = raw.filter { $0.isNumber || $0 == "+" }
        guard isDialableNumber(filtered) else { return nil }
        return URL(string: "tel:\(filtered)")
    }

    private var scoreText: String {
        guard let score = application.evaluation?.matchScore else { return "Pending" }
        return "\(Int(score))%"
    }
    private var locationText: String {
        [application.candidate.currentCity, application.candidate.currentState, application.candidate.currentCountry]
            .compactMap { $0 }.joined(separator: ", ").isEmpty ? "Not Available" : [application.candidate.currentCity, application.candidate.currentState].compactMap { $0 }.joined(separator: ", ")
    }
    private var relocateText: String {
        switch application.candidate.willingToRelocate {
        case .some(true): return "Yes"
        case .some(false): return "No"
        case .none: return "Not stated"
        }
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline).foregroundStyle(KreviaTheme.ink)
            content()
        }
        .kreviaCard()
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.caption).foregroundStyle(KreviaTheme.muted).frame(width: 110, alignment: .leading)
            Text(value).font(.subheadline).foregroundStyle(KreviaTheme.ink)
            Spacer()
        }
    }
}
