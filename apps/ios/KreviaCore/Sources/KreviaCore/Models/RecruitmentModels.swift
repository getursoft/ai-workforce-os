import Foundation

/// Maps 1:1 to apps/api/src/recruitment (`/recruitment/jobs`, `/recruitment/jobs/:id/candidates`).
public struct RecruitmentJob: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let jobCode: String
    public let title: String
    public let description: String
    public let department: String?
    public let location: String?
    public let status: String
    public let minExperienceYears: Int?
    public let maxExperienceYears: Int?
    public let totalResumes: Int
    public let aiRecommendedCount: Int
    public let recruiterShortlistedCount: Int
    public let createdAt: Date
}

public struct RecruitmentJobPage: Codable, Equatable, Sendable {
    public let items: [RecruitmentJob]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let totalPages: Int
}

public struct RecruitmentCandidate: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let fullName: String?
    public let mobileNumber: String?
    public let email: String?
    // Sprint 7.16 (Phase 5/12) — same fields the website/WhatsApp surfaces read; iOS never re-derives
    // or re-extracts any of this itself, only displays what the shared backend already computed.
    public let currentCity: String?
    public let currentState: String?
    public let currentCountry: String?
    public let normalizedRegion: String?
    public let preferredWorkLocations: [String]?
    public let willingToRelocate: Bool?
    public let noticePeriod: String?
}

public struct RecruitmentResumeRef: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let resumeCode: String
    public let fileName: String
    public let parsingStatus: String
    public let parsingError: String?
    public let totalExperienceYears: Int?
    public let relevantExperienceYears: Int?
    public let extractedSkills: [String]?
}

public struct RecruitmentEvaluation: Codable, Equatable, Hashable, Sendable {
    public let matchScore: Double?
    public let matchedSkills: [String]?
    public let missingSkills: [String]?
    public let explanation: String?
    public let warnings: [String]?
    public let evaluationStatus: String
}

public struct RecruitmentApplication: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let jobId: String
    public let candidate: RecruitmentCandidate
    public let resume: RecruitmentResumeRef
    public let evaluation: RecruitmentEvaluation?
    public let aiRecommendation: String?
    public let recruiterDecision: String
    public let createdAt: Date
}

public struct RecruitmentApplicationPage: Codable, Equatable, Sendable {
    public let items: [RecruitmentApplication]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let totalPages: Int
}

/// Shape of `RecruitmentJob.requiredCriteria` — the request body for job creation.
public struct RecruitmentRequiredCriteria: Encodable, Equatable, Sendable {
    public let mandatorySkills: [String]
    public let preferredSkills: [String]
    public let certifications: [String]

    public init(mandatorySkills: [String], preferredSkills: [String] = [], certifications: [String] = []) {
        self.mandatorySkills = mandatorySkills
        self.preferredSkills = preferredSkills
        self.certifications = certifications
    }
}

/// Default weights mirror the website's own default (Phase 5's documented 35/15/25/15/10 split).
public struct RecruitmentScoringConfig: Encodable, Equatable, Sendable {
    public let mandatorySkillWeight: Int
    public let preferredSkillWeight: Int
    public let experienceWeight: Int
    public let projectExperienceWeight: Int
    public let certificationWeight: Int

    public static let `default` = RecruitmentScoringConfig(
        mandatorySkillWeight: 35, preferredSkillWeight: 15, experienceWeight: 25,
        projectExperienceWeight: 15, certificationWeight: 10
    )
}

public struct RecruitmentSuggestedCriteria: Codable, Equatable, Sendable {
    public let mandatorySkills: [String]
    public let preferredSkills: [String]?
    public let certifications: [String]?
}

public struct RecruitmentUploadBatchResult: Codable, Equatable, Sendable {
    public let batchId: String
    public let totalFiles: Int
}

public struct RecruitmentBatchStatus: Codable, Equatable, Sendable {
    public let status: String
    public let totalFiles: Int
    public let completed: Int
    public let processing: Int
    public let failed: Int
    public let queued: Int
}

/// Sprint 7.16 (Phase 6/12) — posted to POST /recruitment/candidates/search, the SAME endpoint and query
/// shape the website and WhatsApp use (RecruitmentCandidateQueryService server-side). iOS builds this
/// request object from its own filter UI state but never computes a match itself — identical requests
/// from iOS and the website return identical results by construction (Phase 12's requirement).
public struct RecruitmentCandidateQuery: Encodable, Equatable, Sendable {
    public var jobId: String?
    public var scoreGreaterThan: Double?
    public var scoreGreaterThanOrEqual: Double?
    public var scoreLessThan: Double?
    public var scoreLessThanOrEqual: Double?
    public var currentCity: [String]?
    public var currentState: [String]?
    public var region: [String]?
    public var willingToRelocate: Bool?
    public var minRelevantExperienceYears: Int?
    public var maxRelevantExperienceYears: Int?
    public var allSkills: [String]?
    public var anySkills: [String]?
    public var search: String?
    public var sortBy: String?
    public var cursor: String?
    public var limit: Int?

    public init(
        jobId: String? = nil, scoreGreaterThan: Double? = nil, scoreGreaterThanOrEqual: Double? = nil,
        scoreLessThan: Double? = nil, scoreLessThanOrEqual: Double? = nil, currentCity: [String]? = nil,
        currentState: [String]? = nil, region: [String]? = nil, willingToRelocate: Bool? = nil,
        minRelevantExperienceYears: Int? = nil, maxRelevantExperienceYears: Int? = nil,
        allSkills: [String]? = nil, anySkills: [String]? = nil, search: String? = nil, sortBy: String? = nil,
        cursor: String? = nil, limit: Int? = nil
    ) {
        self.jobId = jobId
        self.scoreGreaterThan = scoreGreaterThan
        self.scoreGreaterThanOrEqual = scoreGreaterThanOrEqual
        self.scoreLessThan = scoreLessThan
        self.scoreLessThanOrEqual = scoreLessThanOrEqual
        self.currentCity = currentCity
        self.currentState = currentState
        self.region = region
        self.willingToRelocate = willingToRelocate
        self.minRelevantExperienceYears = minRelevantExperienceYears
        self.maxRelevantExperienceYears = maxRelevantExperienceYears
        self.allSkills = allSkills
        self.anySkills = anySkills
        self.search = search
        self.sortBy = sortBy
        self.cursor = cursor
        self.limit = limit
    }
}

public struct RecruitmentCandidateQueryResult: Codable, Equatable, Sendable {
    public let items: [RecruitmentApplication]
    public let nextCursor: String?
    public let totalCount: Int
}

/// Sprint 7.17 (Phase 2/3) — mirrors the website's RequestExportDto exactly.
struct RecruitmentExportRequest: Encodable {
    let scope: String
    let format: String
    let jobId: String?
    let filters: RecruitmentCandidateQuery?
    let selectedApplicationIds: [String]?
}

public struct RecruitmentExportRequestResult: Codable, Equatable, Sendable {
    public let exportJobId: String
    public let status: String
    public let rowCount: Int
    public let downloadToken: String?
}

public struct RecruitmentExportStatus: Codable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let rowCount: Int?
    public let errorMessage: String?
    public let downloadToken: String?
}
