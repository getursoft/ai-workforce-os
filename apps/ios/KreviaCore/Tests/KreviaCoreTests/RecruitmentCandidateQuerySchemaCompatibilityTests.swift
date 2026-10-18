import XCTest
@testable import KreviaCore

/// Sprint 7.17 (Phase 4) — a real, automated cross-platform contract check. The backend cross-platform
/// e2e spec (apps/api/src/recruitment/recruitment-cross-platform.e2e.spec.ts) proves website's HTTP path
/// and WhatsApp's in-process path agree on real backend state for ten scenarios. iOS cannot be driven by
/// that spec (it never runs in Node), so this test instead locks in the one thing that would silently
/// break cross-platform consistency from the iOS side without any of those backend tests ever noticing:
/// iOS's RecruitmentCandidateQuery encoding a field under a DIFFERENT key name than the backend's
/// AdvancedCandidateQueryDto expects (e.g. iOS sending "minScore" while the server reads
/// "scoreGreaterThanOrEqual") — a request that would silently return the wrong (or all) results rather
/// than erroring. Every key name here is copied verbatim from
/// apps/api/src/recruitment/recruitment.dto.ts's AdvancedCandidateQueryDto.
@MainActor
final class RecruitmentCandidateQuerySchemaCompatibilityTests: XCTestCase {
    private static let backendFieldNames: Set<String> = [
        "jobId", "scoreGreaterThan", "scoreGreaterThanOrEqual", "scoreLessThan", "scoreLessThanOrEqual",
        "currentCity", "currentState", "currentCountry", "region", "preferredWorkLocation", "willingToRelocate",
        "minTotalExperienceYears", "maxTotalExperienceYears", "minRelevantExperienceYears", "maxRelevantExperienceYears",
        "allSkills", "anySkills", "mandatorySkillsFullyMatched", "aiRecommendation", "recruiterDecision",
        "applicationStatus", "uploadDateFrom", "uploadDateTo", "evaluationDateFrom", "evaluationDateTo",
        "sourceChannel", "search", "sortBy", "cursor", "limit"
    ]

    func testEveryFieldIOSCanSendMatchesABackendFieldNameExactly() throws {
        let query = RecruitmentCandidateQuery(
            jobId: "job-1",
            scoreGreaterThan: 80, scoreGreaterThanOrEqual: 80, scoreLessThan: 80, scoreLessThanOrEqual: 80,
            currentCity: ["Noida"], currentState: ["Uttar Pradesh"], region: ["Delhi NCR"],
            willingToRelocate: true,
            minRelevantExperienceYears: 1, maxRelevantExperienceYears: 10,
            allSkills: ["Python"], anySkills: ["SQL"],
            search: "Rahul", sortBy: "score_desc", cursor: "abc", limit: 20
        )
        let data = try JSONEncoder().encode(query)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertFalse(json.isEmpty, "Sanity check: the encoded query must not be empty.")
        for key in json.keys {
            XCTAssertTrue(
                Self.backendFieldNames.contains(key),
                "iOS encoded a field named '\(key)' that AdvancedCandidateQueryDto does not declare — " +
                "this request would silently be dropped or misinterpreted server-side, breaking cross-platform consistency."
            )
        }

        // The specific boundary/location/skill fields Phase 4's CP-003/004/005 scenarios exercise must be
        // present under their exact expected names (not just "some valid subset").
        for expected in ["scoreGreaterThanOrEqual", "scoreGreaterThan", "currentCity", "region", "anySkills", "minRelevantExperienceYears", "sortBy"] {
            XCTAssertNotNil(json[expected], "Expected iOS to encode '\(expected)' for a Phase 4-relevant filter, but it was missing.")
        }
    }
}
