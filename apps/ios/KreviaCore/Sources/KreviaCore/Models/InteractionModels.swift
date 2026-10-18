import Foundation

/// Maps 1:1 to apps/api/src/interaction/interaction.controller.ts (`/interactions`) and its
/// `InteractionAdminService.toSummary()` — read-only, tenant-scoped conversation history across
/// web chat, WhatsApp, and voice. Contact fields arrive already masked by the backend.
public enum InteractionChannel: String, Codable, Equatable, Sendable {
    case webChat = "WEB_CHAT"
    case whatsapp = "WHATSAPP"
    case voice = "VOICE"

    public var displayName: String {
        switch self {
        case .webChat: return "Web Chat"
        case .whatsapp: return "WhatsApp"
        case .voice: return "Voice"
        }
    }

    public var systemImage: String {
        switch self {
        case .webChat: return "bubble.left.and.bubble.right.fill"
        case .whatsapp: return "message.fill"
        case .voice: return "phone.fill"
        }
    }
}

public enum InteractionStatus: String, Codable, Equatable, Sendable {
    case open = "OPEN"
    case active = "ACTIVE"
    case waiting = "WAITING"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case cancelled = "CANCELLED"

    public var displayName: String {
        rawValue.capitalized
    }
}

public struct InteractionSummary: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let referenceId: String
    public let channel: InteractionChannel
    public let transport: String
    public let status: InteractionStatus
    public let conversationId: String?
    public let voiceSessionId: String?
    public let channelConnectionId: String?
    public let entryAgentId: String?
    public let currentAgentId: String?
    public let phoneNumber: String?
    public let email: String?
    public let startedAt: Date
    public let lastActivityAt: Date
    public let completedAt: Date?
    public let resolutionSummary: String?
    public let referenceCommunicatedAt: Date?
}

public struct InteractionPage: Codable, Equatable, Sendable {
    public let items: [InteractionSummary]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let totalPages: Int

    public var hasMorePages: Bool { page < totalPages }
}
