import XCTest
@testable import KreviaCore

final class LeadDecodingTests: XCTestCase {
    func testDecodesLeadFromRealAPIShape() throws {
        // Matches Lead.service.ts's prisma row shape verbatim.
        let json = """
        {
          "id": "b07f28d2-6a28-4779-b346-845ee4fdc51a",
          "organizationId": "3d4c4643-1880-45e5-8b1d-7176b4479b20",
          "leadReferenceId": "KRV-LD-C3P487",
          "name": "Arjun Mehta",
          "phone": "+919812300000",
          "email": null,
          "source": "MANUAL",
          "agentId": null,
          "conversationId": null,
          "interactionId": null,
          "voiceSessionId": null,
          "requirement": "Interested in a family Europe tour",
          "status": "NEW",
          "priority": "MEDIUM",
          "assignedToUserId": null,
          "createdAt": "2026-09-21T09:15:39.732Z",
          "updatedAt": "2026-09-21T09:15:39.732Z",
          "lastActivityAt": "2026-09-21T09:15:39.731Z",
          "convertedAt": null,
          "lostAt": null
        }
        """
        let lead = try makeDecoder().decode(Lead.self, from: Data(json.utf8))
        XCTAssertEqual(lead.leadReferenceId, "KRV-LD-C3P487")
        XCTAssertEqual(lead.source, .manual)
        XCTAssertEqual(lead.status, .new)
        XCTAssertEqual(lead.priority, .medium)
        XCTAssertNil(lead.email)
        XCTAssertNotNil(lead.createdAt)
    }

    func testDecodesLeadPage() throws {
        let json = """
        { "items": [], "total": 0, "page": 1, "pageSize": 20, "totalPages": 1 }
        """
        let page = try makeDecoder().decode(LeadPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.total, 0)
        XCTAssertEqual(page.totalPages, 1)
        XCTAssertTrue(page.items.isEmpty)
    }

    func testDecodesLeadSummary() throws {
        let json = """
        { "total": 6, "new": 2, "contacted": 1, "qualified": 1, "followUp": 1, "converted": 1, "lost": 0 }
        """
        let summary = try makeDecoder().decode(LeadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.total, 6)
        XCTAssertEqual(summary.followUp, 1)
    }

    func testDecodesLeadActivity() throws {
        let json = """
        {
          "id": "activity-1",
          "leadId": "lead-1",
          "type": "STATUS_CHANGED",
          "note": "Status changed from NEW to CONTACTED.",
          "actorUserId": "user-1",
          "createdAt": "2026-09-21T09:15:39.732Z"
        }
        """
        let activity = try makeDecoder().decode(LeadActivity.self, from: Data(json.utf8))
        XCTAssertEqual(activity.type, .statusChanged)
        XCTAssertEqual(activity.note, "Status changed from NEW to CONTACTED.")
    }
}

func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "bad date")
    }
    return decoder
}
