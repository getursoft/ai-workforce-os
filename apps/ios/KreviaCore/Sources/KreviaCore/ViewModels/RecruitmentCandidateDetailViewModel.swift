import Foundation

/// Sprint 7.17 (Phase 2/5) — candidate detail + the manual-calling audit trail. Contact visibility and
/// calling are gated by the user's REAL effective permissions (fetched live, not cached/assumed),
/// mirroring the WhatsApp menu service's own showCandidateDetail check. Two independent permissions:
/// `recruitment.candidates.contact` (may SEE the number) and `recruitment.candidates.call` (may place/log
/// a call against it) — a recruiter can have one without the other, and the server enforces both
/// independently regardless of what this view model decides to show.
@MainActor
public final class RecruitmentCandidateDetailViewModel: ObservableObject {
    @Published public private(set) var canSeeContact = false
    @Published public private(set) var canCall = false
    @Published public private(set) var isLoadingPermissions = true

    private let service: RecruitmentService
    private let authService: AuthService
    public let application: RecruitmentApplication

    public init(application: RecruitmentApplication, service: RecruitmentService, authService: AuthService) {
        self.application = application
        self.service = service
        self.authService = authService
    }

    public func loadPermissions() async {
        isLoadingPermissions = true
        let permissions = (try? await authService.permissions()) ?? []
        canSeeContact = permissions.contains("recruitment.candidates.contact")
        canCall = permissions.contains("recruitment.candidates.call")
        isLoadingPermissions = false
        // Phase 5: "Audit event for access to candidate contact information" — fired the moment the
        // number is actually revealed in the UI, not deferred until a call is placed.
        if canSeeContact {
            _ = try? await service.recordCallEvent(
                candidateId: application.candidate.id, status: "CONTACT_VIEWED",
                jobId: application.jobId, applicationId: application.id, platform: "IOS"
            )
        }
    }

    /// Phase 5: called the moment the recruiter actually taps to call and the native dialer is about to
    /// open — never claims more than "a tel: link was opened" (opening the dialer is not proof a call was
    /// placed, let alone connected).
    public func logCallLinkOpened() async {
        guard canCall else { return }
        _ = try? await service.recordCallEvent(
            candidateId: application.candidate.id, status: "CALL_LINK_OPENED",
            jobId: application.jobId, applicationId: application.id, platform: "IOS"
        )
    }

    /// Phase 5: the recruiter was shown a call confirmation and backed out before the dialer opened.
    public func logCallCancelled() async {
        guard canCall else { return }
        _ = try? await service.recordCallEvent(
            candidateId: application.candidate.id, status: "CALL_CANCELLED",
            jobId: application.jobId, applicationId: application.id, platform: "IOS"
        )
    }

    /// Exports just this one candidate via scope=SELECTED with a single application id — reuses the
    /// exact same export engine as the filtered/bulk paths, not a separate code path.
    public func exportResultsSingle() async -> URL? {
        do {
            let result = try await service.requestExport(scope: "SELECTED", format: "CSV", selectedApplicationIds: [application.id])
            guard result.status == "COMPLETED", let token = result.downloadToken else { return nil }
            return try await service.exportDownloadURL(exportJobId: result.exportJobId, token: token)
        } catch {
            return nil
        }
    }
}
