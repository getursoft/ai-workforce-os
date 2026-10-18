import Foundation

// Matches apps/api/src/leads/lead.service.ts / lead.dto.ts and the Lead Prisma model.

public enum LeadSource: String, Codable, CaseIterable, Sendable, Identifiable {
    case webChat = "WEB_CHAT"
    case whatsapp = "WHATSAPP"
    case voice = "VOICE"
    case manual = "MANUAL"
    case api = "API"
    case other = "OTHER"

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .webChat: return "Web Chat"
        case .whatsapp: return "WhatsApp"
        case .voice: return "Voice"
        case .manual: return "Manual"
        case .api: return "API"
        case .other: return "Other"
        }
    }
}

public enum LeadStatus: String, Codable, CaseIterable, Sendable, Identifiable {
    case new = "NEW"
    case contacted = "CONTACTED"
    case qualified = "QUALIFIED"
    case followUp = "FOLLOW_UP"
    case converted = "CONVERTED"
    case lost = "LOST"

    public var id: String { rawValue }

    public var displayName: String { rawValue.replacingOccurrences(of: "_", with: " ") }
}

public enum LeadPriority: String, Codable, CaseIterable, Sendable, Identifiable {
    case low = "LOW"
    case medium = "MEDIUM"
    case high = "HIGH"

    public var id: String { rawValue }
}

public enum LeadActivityType: String, Codable, Sendable {
    case created = "CREATED"
    case updated = "UPDATED"
    case statusChanged = "STATUS_CHANGED"
    case assigned = "ASSIGNED"
    case noteAdded = "NOTE_ADDED"
    case contacted = "CONTACTED"
    case converted = "CONVERTED"
    case lost = "LOST"

    public var displayName: String { rawValue.replacingOccurrences(of: "_", with: " ") }
}

public struct Lead: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let organizationId: String
    public let leadReferenceId: String
    public let name: String?
    public let phone: String?
    public let email: String?
    public let source: LeadSource
    public let agentId: String?
    public let conversationId: String?
    public let interactionId: String?
    public let voiceSessionId: String?
    public let requirement: String?
    public let status: LeadStatus
    public let priority: LeadPriority
    public let assignedToUserId: String?
    public let createdAt: Date
    public let updatedAt: Date
    public let lastActivityAt: Date
    public let convertedAt: Date?
    public let lostAt: Date?
}

public struct LeadActivity: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let leadId: String
    public let type: LeadActivityType
    public let note: String?
    public let actorUserId: String?
    public let createdAt: Date
}

public struct LeadSummary: Codable, Equatable, Sendable {
    public let total: Int
    public let new: Int
    public let contacted: Int
    public let qualified: Int
    public let followUp: Int
    public let converted: Int
    public let lost: Int
}

public struct LeadPage: Codable, Equatable, Sendable {
    public let items: [Lead]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let totalPages: Int
}
