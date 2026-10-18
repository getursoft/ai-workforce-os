import XCTest
@testable import KreviaCore

final class BillingDecodingTests: XCTestCase {
    private func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: value) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            if let date = plain.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognized date: \(value)")
        }
        return decoder
    }

    func testDecodesEmployeeOverviewFromRealAPIShape() throws {
        let json = """
        {"pluginInstallationId":"plugin-1","name":"Sales","type":"sales-employee","active":true,
         "conversations":12,"leadsGenerated":3,"creditsConsumed":48,
         "lastActivityAt":"2026-09-27T10:00:00.000Z"}
        """.data(using: .utf8)!
        let employee = try makeDecoder().decode(EmployeeOverview.self, from: json)
        XCTAssertEqual(employee.pluginInstallationId, "plugin-1")
        XCTAssertTrue(employee.active)
        XCTAssertEqual(employee.leadsGenerated, 3)
        XCTAssertNotNil(employee.lastActivityAt)
    }

    func testDecodesEmployeeOverviewWithNullLastActivity() throws {
        let json = """
        {"pluginInstallationId":"plugin-2","name":"HR","type":"hr-employee","active":false,
         "conversations":0,"leadsGenerated":0,"creditsConsumed":0,"lastActivityAt":null}
        """.data(using: .utf8)!
        let employee = try makeDecoder().decode(EmployeeOverview.self, from: json)
        XCTAssertNil(employee.lastActivityAt)
    }

    func testDecodesEmployeeDetailFromRealAPIShape() throws {
        let json = """
        {"pluginInstallationId":"plugin-1","name":"Sales","type":"sales-employee","active":true,
         "usageToday":{"creditsConsumed":4,"executions":2},
         "usageWeek":{"creditsConsumed":20,"executions":10},
         "usageMonth":{"creditsConsumed":48,"executions":24},
         "leadsGenerated":3,"conversations":24,
         "recentActivity":[{"id":"exec-1","status":"COMPLETED","occurredAt":"2026-09-27T10:00:00.000Z","creditsConsumed":2}]}
        """.data(using: .utf8)!
        let detail = try makeDecoder().decode(EmployeeDetail.self, from: json)
        XCTAssertEqual(detail.usageToday.creditsConsumed, 4)
        XCTAssertEqual(detail.usageMonth.executions, 24)
        XCTAssertEqual(detail.recentActivity.count, 1)
    }

    func testDecodesUsageSummaryFromRealAPIShape() throws {
        let json = """
        {"plan":{"code":"GROWTH","name":"Growth"},
         "billingCycle":{"start":"2026-09-01T00:00:00.000Z","end":"2026-09-30T23:59:59.999Z"},
         "currency":"INR","monthlyAllowanceCredits":500000,"usedCredits":120000,"remainingCredits":380000,
         "usagePercentage":24,"estimatedOverageAmountMinor":0,"threshold":"NORMAL",
         "tokens":{"input":10000,"output":5000,"cachedInput":0,"reasoning":0,"total":15000},
         "totalRequests":42}
        """.data(using: .utf8)!
        let summary = try makeDecoder().decode(UsageSummary.self, from: json)
        XCTAssertEqual(summary.remainingCredits, 380000)
        XCTAssertEqual(summary.threshold, .normal)
        XCTAssertEqual(summary.plan?.code, "GROWTH")
    }

    func testDecodesUsageSummaryWithNoSubscription() throws {
        let json = """
        {"plan":null,"billingCycle":null,"currency":"INR","monthlyAllowanceCredits":0,"usedCredits":0,
         "remainingCredits":0,"usagePercentage":0,"estimatedOverageAmountMinor":0,"threshold":"NORMAL",
         "tokens":{"input":0,"output":0,"cachedInput":0,"reasoning":0,"total":0},"totalRequests":0}
        """.data(using: .utf8)!
        let summary = try makeDecoder().decode(UsageSummary.self, from: json)
        XCTAssertNil(summary.plan)
        XCTAssertNil(summary.billingCycle)
    }

    func testDecodesCreditPackagesResponse() throws {
        let json = """
        {"currency":"INR","packages":[{"credits":10000,"amountMinor":1000000,"currency":"INR"},
         {"credits":50000,"amountMinor":5000000,"currency":"INR"}]}
        """.data(using: .utf8)!
        let response = try makeDecoder().decode(CreditPackagesResponse.self, from: json)
        XCTAssertEqual(response.packages.count, 2)
        XCTAssertEqual(response.packages.first?.credits, 10000)
    }

    func testDecodesCreditPurchaseOrderView() throws {
        let json = """
        {"id":"order-1","credits":10000,"amountMinor":1000000,"currency":"INR","status":"PENDING",
         "gatewayOrderId":"order_gw_1","razorpayKeyId":"rzp_test_key"}
        """.data(using: .utf8)!
        let order = try makeDecoder().decode(CreditPurchaseOrderView.self, from: json)
        XCTAssertEqual(order.status, "PENDING")
        XCTAssertEqual(order.razorpayKeyId, "rzp_test_key")
    }

    func testDecodesCreditPurchaseOrderSummaryList() throws {
        let json = """
        [{"id":"order-1","credits":10000,"amountMinor":1000000,"currency":"INR","status":"PAID",
          "gateway":"RAZORPAY","createdAt":"2026-09-20T10:00:00.000Z","paidAt":"2026-09-20T10:05:00.000Z"}]
        """.data(using: .utf8)!
        let orders = try makeDecoder().decode([CreditPurchaseOrderSummary].self, from: json)
        XCTAssertEqual(orders.first?.status, "PAID")
        XCTAssertNotNil(orders.first?.paidAt)
    }

    func testDecodesVerifyResult() throws {
        let json = #"{"status":"PAID","credits":10000}"#.data(using: .utf8)!
        let result = try makeDecoder().decode(VerifyCreditPurchaseOrderResult.self, from: json)
        XCTAssertEqual(result.status, "PAID")
        XCTAssertEqual(result.credits, 10000)
    }

    func testDecodesUsageTrendPoints() throws {
        let json = """
        [{"date":"2026-09-27","creditsConsumed":4,"inputTokens":100,"outputTokens":50,"totalTokens":150,"requests":2}]
        """.data(using: .utf8)!
        let points = try makeDecoder().decode([UsageTrendPoint].self, from: json)
        XCTAssertEqual(points.first?.date, "2026-09-27")
        XCTAssertEqual(points.first?.creditsConsumed, 4)
    }
}
