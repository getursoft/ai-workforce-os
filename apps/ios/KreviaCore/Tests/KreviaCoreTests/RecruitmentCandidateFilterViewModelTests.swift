import XCTest
@testable import KreviaCore

/// Sprint 7.17 (Phase 2) — real unit tests for the new iOS advanced-filter screen's view model, run via
/// `swift test`, not merely proven by a successful build. Uses the same MockURLProtocol/jsonResponse
/// harness as the existing LeadListViewModelTests.
@MainActor
final class RecruitmentCandidateFilterViewModelTests: XCTestCase {
    private func makeService(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> RecruitmentService {
        MockURLProtocol.handler = handler
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return RecruitmentService(client: client)
    }

    private func application(_ id: String, score: Double?) -> String {
        """
        {"id":"\(id)","jobId":"job-1",
         "candidate":{"id":"c-\(id)","fullName":"Test Candidate","mobileNumber":"+911234567890","email":"t@example.com",
           "currentCity":"Noida","currentState":"Uttar Pradesh","currentCountry":"India","normalizedRegion":"Delhi NCR",
           "preferredWorkLocations":["Delhi"],"willingToRelocate":true,"workModePreference":null,"noticePeriod":"30 days"},
         "resume":{"id":"r-\(id)","resumeCode":"RES-\(id)","fileName":"r.pdf","parsingStatus":"COMPLETED","parsingError":null,
           "totalExperienceYears":5,"relevantExperienceYears":4,"extractedSkills":["Python"]},
         "evaluation":\(score != nil ? #"{"matchScore":\#(score!),"matchedSkills":["Python"],"missingSkills":[],"explanation":null,"warnings":null,"evaluationStatus":"COMPLETED"}"# : "null"),
         "aiRecommendation":"RECOMMENDED_FOR_SHORTLIST","recruiterDecision":"PENDING_REVIEW","createdAt":"2026-10-12T00:00:00.000Z"}
        """
    }

    func testApplyFiltersPopulatesItemsAndTotalCount() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.application("A-1", score: 85)),\#(self.application("A-2", score: 60))],"nextCursor":null,"totalCount":2}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service, jobId: "job-1")
        viewModel.scoreMin = "50"
        await viewModel.applyFilters()
        XCTAssertEqual(viewModel.items.count, 2)
        XCTAssertEqual(viewModel.totalCount, 2)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.hasMore)
    }

    func testApplyFiltersSetsHasMoreWhenCursorReturned() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.application("A-1", score: 85))],"nextCursor":"cursor-abc","totalCount":5}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        await viewModel.applyFilters()
        XCTAssertTrue(viewModel.hasMore)
    }

    func testLoadMoreAppendsResultsWithoutDuplicatingExisting() async {
        var callCount = 0
        let service = makeService { request in
            callCount += 1
            if callCount == 1 {
                return jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.application("A-1", score: 85))],"nextCursor":"cursor-1","totalCount":2}"#)
            }
            return jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.application("A-2", score: 60))],"nextCursor":null,"totalCount":2}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        await viewModel.applyFilters()
        await viewModel.loadMore()
        XCTAssertEqual(viewModel.items.map(\.id), ["A-1", "A-2"])
        XCTAssertFalse(viewModel.hasMore)
    }

    func testErrorSetsErrorMessageAndLeavesItemsEmpty() async {
        let service = makeService { request in
            jsonResponse(
                request.url!, status: 403,
                json: #"{"error":{"code":"FORBIDDEN","message":"You don't have permission to do that.","details":[],"requestId":"r1","timestamp":"2026-10-12T00:00:00.000Z"}}"#
            )
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        await viewModel.applyFilters()
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.items.isEmpty)
    }

    func testClearFiltersResetsAllState() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"items":[\#(self.application("A-1", score: 85))],"nextCursor":null,"totalCount":1}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        viewModel.scoreMin = "80"
        viewModel.currentCity = "Noida"
        await viewModel.applyFilters()
        viewModel.toggleSelection("A-1")
        XCTAssertFalse(viewModel.items.isEmpty)
        XCTAssertFalse(viewModel.selectedIds.isEmpty)

        viewModel.clearFilters()
        XCTAssertTrue(viewModel.items.isEmpty)
        XCTAssertTrue(viewModel.selectedIds.isEmpty)
        XCTAssertEqual(viewModel.scoreMin, "")
        XCTAssertEqual(viewModel.currentCity, "")
        XCTAssertFalse(viewModel.hasActiveFilters)
    }

    func testToggleSelectionAddsAndRemoves() {
        let service = makeService { request in jsonResponse(request.url!, status: 200, json: "{}") }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        XCTAssertFalse(viewModel.selectedIds.contains("A-1"))
        viewModel.toggleSelection("A-1")
        XCTAssertTrue(viewModel.selectedIds.contains("A-1"))
        viewModel.toggleSelection("A-1")
        XCTAssertFalse(viewModel.selectedIds.contains("A-1"))
    }

    func testExportResultsReturnsURLWhenCompleted() async {
        let service = makeService { request in
            if request.url!.path.contains("/export/") {
                return jsonResponse(request.url!, status: 200, json: #"{"url":"https://storage.test/export.csv?sig=abc"}"#)
            }
            return jsonResponse(request.url!, status: 200, json: #"{"exportJobId":"exp-1","status":"COMPLETED","rowCount":2,"downloadToken":"tok-123"}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service, jobId: "job-1")
        let url = await viewModel.exportResults()
        XCTAssertNotNil(url)
        XCTAssertEqual(url?.absoluteString, "https://storage.test/export.csv?sig=abc")
    }

    func testExportResultsReturnsNilWhenQueued() async {
        let service = makeService { request in
            jsonResponse(request.url!, status: 200, json: #"{"exportJobId":"exp-2","status":"QUEUED","rowCount":9000,"downloadToken":null}"#)
        }
        let viewModel = RecruitmentCandidateFilterViewModel(service: service)
        let url = await viewModel.exportResults()
        XCTAssertNil(url)
        XCTAssertTrue(viewModel.exportNotice?.contains("queued") ?? false)
    }
}

/// Sprint 7.17 (Phase 5) — contact-permission gating and call-access audit logging.
@MainActor
final class RecruitmentCandidateDetailViewModelTests: XCTestCase {
    /// `onCallLogStatus` is invoked once per call-log POST with the request's `status` field. A plain
    /// optional-closure call (no Swift generic/Sequence method in the call chain) — proven safe to invoke
    /// from MockURLProtocol's background loading thread, unlike `.map`/`.append` on a value lexically
    /// captured from a @MainActor context (see the precomputed-`permsJson` comment below).
    private func makeServices(
        permissions: [String],
        onCallLogStatus: ((String?) -> Void)? = nil
    ) -> (RecruitmentService, AuthService) {
        // Precomputed here (on the @MainActor test context) rather than inside the closure below: that
        // closure runs on MockURLProtocol's background loading thread, and calling a generic Sequence
        // method like `.map` from inside a closure lexically created in a @MainActor context triggers a
        // dynamic actor-isolation check that traps (SIGTRAP) when it actually executes off the main thread.
        let permsJson = permissions.map { "\"\($0)\"" }.joined(separator: ",")
        MockURLProtocol.handler = { request in
            if request.url!.path.contains("call-log") {
                // JSONSerialization is Objective-C-bridged, not a Swift generic — safe to call here,
                // unlike Array.append/.map (see the actor-isolation note above). URLSession moves a
                // request's `httpBody` into `httpBodyStream` internally before handing it to a custom
                // URLProtocol, so `httpBody` alone reads back nil here — read the stream instead.
                var status: String?
                if let data = Self.bodyData(from: request), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    status = json["status"] as? String
                }
                onCallLogStatus?(status)
                return jsonResponse(request.url!, status: 200, json: #"{"id":"call-1"}"#)
            }
            return jsonResponse(request.url!, status: 200, json: #"{"permissions":[\#(permsJson)]}"#)
        }
        let client = APIClient(
            baseURL: URL(string: "https://api.test/api/v1")!,
            session: MockURLProtocol.makeSession(),
            tokenStore: InMemoryTokenStore()
        )
        return (RecruitmentService(client: client), AuthService(client: client))
    }

    /// `nonisolated` (and uses only ObjC-bridged APIs, never a Swift generic/protocol-witness call like
    /// `.append`/`.map`) so it's genuinely safe to call from MockURLProtocol's background loading thread.
    nonisolated private static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        let output = NSMutableData()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            output.append(buffer, length: read)
        }
        return output as Data
    }

    private func sampleApplication() -> RecruitmentApplication {
        let json = """
        {"id":"A-1","jobId":"job-1",
         "candidate":{"id":"c-1","fullName":"Jane Doe","mobileNumber":"+911234567890","email":"jane@example.com",
           "currentCity":"Noida","currentState":null,"currentCountry":null,"normalizedRegion":null,
           "preferredWorkLocations":[],"willingToRelocate":null,"workModePreference":null,"noticePeriod":null},
         "resume":{"id":"r-1","resumeCode":"RES-1","fileName":"r.pdf","parsingStatus":"COMPLETED","parsingError":null,
           "totalExperienceYears":5,"relevantExperienceYears":4,"extractedSkills":[]},
         "evaluation":null,"aiRecommendation":null,"recruiterDecision":"PENDING_REVIEW","createdAt":"2026-10-12T00:00:00.000Z"}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "bad date")
        }
        return try! decoder.decode(RecruitmentApplication.self, from: Data(json.utf8))
    }

    func testCanSeeContactTrueWhenPermissionGrantedButCanCallFalseWithoutIt() async {
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact"])
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        XCTAssertTrue(viewModel.canSeeContact)
        // Phase 5: contact and calling are two independent permissions — having one must not imply the other.
        XCTAssertFalse(viewModel.canCall)
    }

    func testCanSeeContactFalseWhenPermissionMissing() async {
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.jobs.read"])
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        XCTAssertFalse(viewModel.canSeeContact)
        XCTAssertFalse(viewModel.canCall)
    }

    func testCanCallTrueWhenBothPermissionsGranted() async {
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact", "recruitment.candidates.call"])
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        XCTAssertTrue(viewModel.canSeeContact)
        XCTAssertTrue(viewModel.canCall)
    }

    func testLoadPermissionsFiresContactViewedOnlyWhenContactIsVisible() async {
        var lastStatus: String?
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.jobs.read"]) { lastStatus = $0 }
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        // Phase 5: "Audit event for access to candidate contact information" must never fire for a
        // recruiter who was never shown the contact info in the first place.
        XCTAssertNil(lastStatus)
    }

    func testLoadPermissionsFiresContactViewedWhenContactPermissionGranted() async {
        var lastStatus: String?
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact"]) { lastStatus = $0 }
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        XCTAssertEqual(lastStatus, "CONTACT_VIEWED")
    }

    func testLogCallLinkOpenedRequiresCallPermissionNotJustContact() async {
        var lastStatus: String?
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact"]) { lastStatus = $0 }
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        lastStatus = nil // loadPermissions already fired CONTACT_VIEWED above — reset to isolate the next call
        await viewModel.logCallLinkOpened()
        // Phase 5: contact permission alone must not be sufficient to log/place a call.
        XCTAssertNil(lastStatus)
    }

    func testLogCallLinkOpenedFiresWhenCallPermissionGranted() async {
        var lastStatus: String?
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact", "recruitment.candidates.call"]) { lastStatus = $0 }
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        lastStatus = nil
        await viewModel.logCallLinkOpened()
        XCTAssertEqual(lastStatus, "CALL_LINK_OPENED")
    }

    func testLogCallCancelledFiresWhenCallPermissionGranted() async {
        var lastStatus: String?
        let (recruitmentService, authService) = makeServices(permissions: ["recruitment.candidates.contact", "recruitment.candidates.call"]) { lastStatus = $0 }
        let viewModel = RecruitmentCandidateDetailViewModel(application: sampleApplication(), service: recruitmentService, authService: authService)
        await viewModel.loadPermissions()
        lastStatus = nil
        await viewModel.logCallCancelled()
        XCTAssertEqual(lastStatus, "CALL_CANCELLED")
    }
}
