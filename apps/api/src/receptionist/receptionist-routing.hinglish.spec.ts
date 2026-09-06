import { describe, expect, it, vi } from "vitest";
import { ReceptionistRouteDecisionValidator, ReceptionistRoutingService } from "./receptionist-routing.service";
import type { ReceptionistRouteInput } from "./receptionist.types";
import type { WorkforceDirectoryEntry } from "./workforce-directory.service";

/**
 * Sprint 6.6 — Part 5/27/28: adversarial multilingual routing matrix. Fixtures below mirror the REAL
 * manifest keyword arrays (post this sprint's additive-only edits — see plugins/*\/plugin.json) rather
 * than a hand-picked minimal set, so this test would actually catch a real collision the same way the
 * Sprint 6.5 `realisticProfiles` fixture already does for the English-only case.
 */

function profile(
  id: string,
  displayName: string,
  capability: string,
  keywords: string[],
  domains: string[],
  aliases: string[] = [displayName]
): WorkforceDirectoryEntry {
  return {
    pluginInstallationId: id,
    employeeKey: `${id}-employee`,
    employeeType: "SPECIALIST",
    displayName,
    description: `${displayName} description`,
    enabled: true,
    health: "READY",
    capabilities: [capability],
    supportedIntents: [`${id.toUpperCase()}_REQUEST`],
    routingAliases: [...aliases, ...keywords],
    domains,
    examples: [],
    negativeCapabilities: [],
    supportedActions: [`${id.toUpperCase()}_REQUEST`],
    skillCapabilities: [],
    connectorCapabilities: [],
    channelEligibility: ["WEB", "WHATSAPP", "VOICE"],
    delegationEligibility: true,
    currentAvailability: "AVAILABLE",
    routingPriority: 0
  };
}

const realManifestProfiles: WorkforceDirectoryEntry[] = [
  profile(
    "travel",
    "Travel Employee",
    "travel.booking",
    ["travel", "trip", "flight", "hotel", "visa", "holiday", "booking", "vacation", "tour", "itinerary", "package", "budget", "lead", "invoice", "ticket", "jana hai", "yatra"],
    ["travel", "trip planning", "bookings"],
    ["Travel", "Travel team", "Trip planning team"]
  ),
  profile(
    "hr",
    "HR Employee",
    "hr.leave",
    ["leave", "maternity", "paternity", "payroll", "salary", "benefit", "hiring", "onboarding", "employee", "chhutti", "chutti", "attendance", "appraisal", "grievance", "reimburse", "reimbursement", "joining", "claim"],
    ["hr", "human resources", "people operations"],
    ["HR", "Human Resources", "People Ops", "HR team"]
  ),
  profile(
    "finance",
    "Finance Employee",
    "finance.invoice",
    ["finance", "invoice", "invoice payment", "expense", "budget", "reimburse", "accounting", "financial", "payment status", "payment", "tax", "liability", "purchase", "reimbursement", "bill", "claim", "company budget", "company budgeting"],
    ["finance", "accounting", "expenses"],
    ["Finance", "Accounts", "Accounting team", "Finance team"]
  ),
  profile(
    "it",
    "IT Support Employee",
    "it.ticket",
    ["vpn", "computer", "laptop", "password", "network", "software", "hardware", "technical", "access", "login", "password reset", "printer", "outage", "wifi", "install", "device", "ticket", "system"],
    ["it support", "technical support", "helpdesk"],
    ["IT Support", "IT", "Helpdesk", "Tech support"]
  ),
  profile(
    "sales",
    "Sales Employee",
    "sales.quote",
    ["sales", "product", "pricing", "quote", "demo", "buy", "purchase", "lead", "customer lead", "sales follow-up", "prospect", "pipeline", "opportunity", "deal", "order", "trial", "subscription", "proposal"],
    ["sales", "crm", "pipeline"],
    ["Sales", "Sales team", "CRM team"]
  ),
  profile(
    "marketing",
    "Marketing Employee",
    "marketing.campaign",
    ["marketing", "campaign", "content", "brand", "social", "advertising", "promotion", "seo", "webinar", "email marketing", "ad", "blog", "video", "performance"],
    ["marketing", "campaigns", "content"],
    ["Marketing", "Marketing team", "Brand team"]
  ),
  profile(
    "legal",
    "Legal Employee",
    "legal.review",
    ["legal", "contract", "contract review", "employment contract", "agreement", "notice", "compliance", "regulatory", "gst", "liability", "clause", "advocate", "deadline", "legal notice", "legal opinion"],
    ["legal", "compliance", "contracts"],
    ["Legal", "Legal team", "Advocate"]
  ),
  profile(
    "support",
    "Customer Support Employee",
    "support.order",
    ["support", "customer service", "refund", "return", "order status", "delivery problem", "billing issue", "complaint", "support ticket", "billing", "delivery", "shipping", "cancel", "account", "subscription", "order", "status", "track", "customer ka issue"],
    ["customer support", "support", "service"],
    ["Customer Support", "Support", "Support team"]
  )
];

function input(message: string, overrides: Partial<ReceptionistRouteInput> = {}): ReceptionistRouteInput {
  return {
    organizationId: "organization-1",
    receptionistInstallationId: "receptionist",
    conversationId: "conversation-1",
    customerIdentity: { id: null, type: "ANONYMOUS", displayName: null, locale: "en", timezone: "UTC" },
    message,
    attachmentMetadata: [],
    conversationSummary: null,
    currentHandoff: null,
    channel: "WEB",
    llmRoutingEnabled: false,
    minimumRoutingConfidence: 0.85,
    clarificationEnabled: true,
    pendingInputSatisfied: false,
    recentSpecialistMessage: null,
    ...overrides
  };
}

function service(entries = realManifestProfiles) {
  const eligible = vi.fn().mockResolvedValue(entries);
  const pluginAi = { resolveProvider: vi.fn() };
  return {
    eligible,
    router: new ReceptionistRoutingService({ eligible } as never, pluginAi as never, new ReceptionistRouteDecisionValidator())
  };
}

function activeHandoff(target: string): NonNullable<ReceptionistRouteInput["currentHandoff"]> {
  return {
    id: "handoff-1",
    targetEmployeeInstallationId: target,
    targetConversationId: `${target}-conversation`,
    routingIntent: null,
    routingCapability: null,
    routingConfidence: 0.9,
    status: "HANDOFF_ACTIVE"
  };
}

describe("Multilingual (Hinglish) routing — cold start (Sprint 6.6 Part 5/28)", () => {
  it.each([
    ["Dubai jana hai next month", "travel"],
    ["Yatra plan karni hai", "travel"],
    ["Salary ka issue hai", "hr"],
    ["Chutti chahiye", "hr"],
    ["Invoice payment ka issue hai", "finance"],
    ["Login nahi ho raha", "it"],
    ["System issue hai", "it"],
    ["Sales lead chahiye", "sales"],
    ["Campaign banana hai", "marketing"],
    ["Notice ka reply", "legal"],
    ["Customer ka issue", "support"]
  ])('"%s" routes to %s from a cold start', async (message, target) => {
    const { router } = service();
    const result = await router.route(input(message));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe(target);
  });
});

describe("Multilingual (Hinglish) routing — context still overrides keyword collisions (Sprint 6.6 Part 7)", () => {
  it('Travel active + "Budget thoda badha do" stays in Travel', async () => {
    const { router } = service();
    const result = await router.route(
      input("Budget thoda badha do", { currentHandoff: activeHandoff("travel"), recentSpecialistMessage: "What is your approximate budget?" })
    );
    expect(result.routeType).toBe("CONTINUE_HANDOFF");
  });

  it('Travel active + "Hotel ka invoice kitna tha?" stays in Travel', async () => {
    const { router } = service();
    const result = await router.route(input("Hotel ka invoice kitna tha?", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("CONTINUE_HANDOFF");
  });

  it('Travel active + "Salary ka issue bhi check karna hai" pivots to HR (multi-signal "bhi" + strong "salary" alternative score)', async () => {
    const { router } = service();
    const result = await router.route(input("Salary ka issue bhi check karna hai", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("hr");
  });

  // NOTE (Sprint 6.6 finding, not fixed here — see the final report's Remaining Limitations): the brief's
  // own "HR active + 'Travel reimbursement...' should not jump to Travel merely because 'travel' appears"
  // example does NOT currently hold, even before this sprint's changes — Travel's manifest declares
  // "travel" as its domain AND an alias ("Travel") AND a keyword, so a bare "travel" mention scores 18
  // (6+6+6) rather than 6, a pre-existing structural asymmetry in how domains/aliases/keywords stack that
  // no other employee's manifest happens to trigger this severely. Fixing the scoring formula itself is an
  // architecture change beyond this sprint's mandate (multilingual vocabulary + conversational-state
  // hardening) — flagged honestly rather than silently asserted around.
});

describe("Multilingual (Hinglish) explicit pivot language (Sprint 6.6 Part 8)", () => {
  it.each([
    ["HR pe chalo", "hr"],
    ["HR se baat karni hai", "hr"],
    ["Trip rehne do, salary check karo", "hr"],
    ["Travel chhodo, IT issue hai", "it"],
    ["Ab finance help chahiye", "finance"],
    ["Legal team se baat karni hai", "legal"]
  ])('"%s" while Travel is active pivots to %s', async (message, target) => {
    const { router } = service();
    const result = await router.route(input(message, { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe(target);
  });
});

describe("Multilingual (Hinglish) — required adversarial matrix (Sprint 6.6 Part 28)", () => {
  it('"Budget badha do" stays Travel when Travel is active', async () => {
    const { router } = service();
    const result = await router.route(input("Budget badha do", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("CONTINUE_HANDOFF");
  });

  it('"Company budget ka issue hai" (no active employee) routes to Finance', async () => {
    const { router } = service();
    const result = await router.route(input("Company budget ka issue hai"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("finance");
  });

  it('"Trip rehne do salary check karo" (Travel active) pivots to HR', async () => {
    const { router } = service();
    const result = await router.route(input("Trip rehne do salary check karo", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("hr");
  });

  it('"Hotel invoice kitna tha?" (Travel active) stays Travel', async () => {
    const { router } = service();
    const result = await router.route(input("Hotel invoice kitna tha?", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("CONTINUE_HANDOFF");
  });

  it('"Invoice payment ka issue hai" (no active employee) routes to Finance', async () => {
    const { router } = service();
    const result = await router.route(input("Invoice payment ka issue hai"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("finance");
  });

  it('"Flight ticket nahi mil raha" (Travel active) stays Travel', async () => {
    const { router } = service();
    const result = await router.route(input("Flight ticket nahi mil raha", { currentHandoff: activeHandoff("travel") }));
    expect(result.routeType).toBe("CONTINUE_HANDOFF");
  });

  it('"IT support ticket raise karo" (no active employee) routes to IT', async () => {
    const { router } = service();
    const result = await router.route(input("IT support ticket raise karo"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("it");
  });

  it('"Sales lead dikhao" (no active employee) routes to Sales', async () => {
    const { router } = service();
    const result = await router.route(input("Sales lead dikhao"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("sales");
  });

  it('"Contract check karna hai" (no active employee) routes to Legal', async () => {
    const { router } = service();
    const result = await router.route(input("Contract check karna hai"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("legal");
  });

  it('"Customer complaint hai" (no active employee) routes to Customer Support', async () => {
    const { router } = service();
    const result = await router.route(input("Customer complaint hai"));
    expect(result.routeType).toBe("ROUTE");
    expect(result.primaryEmployeeInstallationId).toBe("support");
  });
});
