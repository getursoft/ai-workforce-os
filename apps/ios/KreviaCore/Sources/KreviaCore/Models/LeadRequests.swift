import Foundation

// Matches apps/api/src/leads/lead.dto.ts

public struct CreateLeadRequest: Codable, Sendable {
    public var name: String?
    public var phone: String?
    public var email: String?
    public var requirement: String?
    public var priority: LeadPriority?
    public var assignedToUserId: String?

    public init(
        name: String? = nil,
        phone: String? = nil,
        email: String? = nil,
        requirement: String? = nil,
        priority: LeadPriority? = nil,
        assignedToUserId: String? = nil
    ) {
        self.name = name
        self.phone = phone
        self.email = email
        self.requirement = requirement
        self.priority = priority
        self.assignedToUserId = assignedToUserId
    }
}

public struct UpdateLeadRequest: Codable, Sendable {
    public var name: String?
    public var phone: String?
    public var email: String?
    public var requirement: String?
    public var status: LeadStatus?
    public var priority: LeadPriority?

    public init(
        name: String? = nil,
        phone: String? = nil,
        email: String? = nil,
        requirement: String? = nil,
        status: LeadStatus? = nil,
        priority: LeadPriority? = nil
    ) {
        self.name = name
        self.phone = phone
        self.email = email
        self.requirement = requirement
        self.status = status
        self.priority = priority
    }
}

public struct AssignLeadRequest: Codable, Sendable {
    public let assignedToUserId: String?
}

public struct AddLeadNoteRequest: Codable, Sendable {
    public let note: String
}

public struct ListLeadsQuery: Sendable {
    public var page: Int = 1
    public var pageSize: Int = 20
    public var status: LeadStatus?
    public var source: LeadSource?
    public var agentId: String?
    public var assignedToUserId: String?
    public var search: String?
    public var dateFrom: Date?
    public var dateTo: Date?

    public init(
        page: Int = 1,
        pageSize: Int = 20,
        status: LeadStatus? = nil,
        source: LeadSource? = nil,
        agentId: String? = nil,
        assignedToUserId: String? = nil,
        search: String? = nil,
        dateFrom: Date? = nil,
        dateTo: Date? = nil
    ) {
        self.page = page
        self.pageSize = pageSize
        self.status = status
        self.source = source
        self.agentId = agentId
        self.assignedToUserId = assignedToUserId
        self.search = search
        self.dateFrom = dateFrom
        self.dateTo = dateTo
    }

    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if let status { items.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let source { items.append(URLQueryItem(name: "source", value: source.rawValue)) }
        if let agentId { items.append(URLQueryItem(name: "agentId", value: agentId)) }
        if let assignedToUserId { items.append(URLQueryItem(name: "assignedToUserId", value: assignedToUserId)) }
        if let search, !search.isEmpty { items.append(URLQueryItem(name: "search", value: search)) }
        if let dateFrom { items.append(URLQueryItem(name: "dateFrom", value: ISO8601DateFormatter().string(from: dateFrom))) }
        if let dateTo { items.append(URLQueryItem(name: "dateTo", value: ISO8601DateFormatter().string(from: dateTo))) }
        return items
    }
}
