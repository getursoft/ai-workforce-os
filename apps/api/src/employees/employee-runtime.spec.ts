import { describe, expect, it } from "vitest";
import {
  buildAttachmentReadMessage,
  buildEmployeeIntentDiscoveryMessage,
  buildEmployeeIntentDiscoveryMessageForVoice,
  buildOutOfScopeRoutingMessage,
  detectOutOfScopeEmployee,
  detectRoutingConfirmation,
  employeeScopeProfile,
  looksLikeAQuestion,
  parseAttachmentBlocks,
  summarizeAttachmentText,
  timeOfDayGreeting
} from "./employee-runtime";
import { HR_DOMAIN_SPEC } from "../hr/hr.runtime";
import { LEGAL_DOMAIN_SPEC } from "../legal/legal.runtime";
import { FINANCE_DOMAIN_SPEC } from "../finance/finance.runtime";

/** Minimal Travel spec for cross-employee routing tests — only `slug` is consulted. */

describe("buildEmployeeIntentDiscoveryMessage", () => {
  it("uses a natural time-of-day greeting + name + help menu, asked once (Sprint 6.3 — Part 4)", () => {
    const message = buildEmployeeIntentDiscoveryMessage(HR_DOMAIN_SPEC, "Krishna", new Date(2026, 6, 31, 9, 0));
    expect(message).toMatch(/^Good morning, Krishna! .*What can I help you with\?/);
    // The old version asked "how may I help you today" and then separately said "I can help you:" —
    // the same question twice. Never regress back to that redundant double-ask.
    expect(message).not.toMatch(/Nice to meet you\./);
    expect(message).not.toMatch(/How may I help you today\?/);
    expect(message).not.toMatch(/I can help you:/);
    expect(message).toMatch(/Ask about leave policy/);
  });

  it("greets with afternoon/evening based on the hour", () => {
    const morning = timeOfDayGreeting(new Date(2026, 0, 1, 9, 0));
    const afternoon = timeOfDayGreeting(new Date(2026, 0, 1, 14, 0));
    const evening = timeOfDayGreeting(new Date(2026, 0, 1, 19, 0));
    expect(morning).toBe("Good morning");
    expect(afternoon).toBe("Good afternoon");
    expect(evening).toBe("Good evening");
  });
});

describe("buildEmployeeIntentDiscoveryMessageForVoice (Sprint 6.3 — Part 5 voice-readiness)", () => {
  it("uses the SAME opening actions as the WEB/WHATSAPP version, as a short spoken sentence with no bullets", () => {
    const voice = buildEmployeeIntentDiscoveryMessageForVoice(HR_DOMAIN_SPEC, "Krishna", new Date(2026, 6, 31, 9, 0));
    expect(voice).not.toMatch(/[•\n]/);
    expect(voice).toMatch(/^Good morning, Krishna!/);
    // Names a couple of the SAME opening actions the WEB menu shows, inline — never a bulleted list.
    expect(voice).toMatch(/ask about leave policy/i);
  });

  it("falls back to a bare greeting when a domain has no opening actions", () => {
    const noActionsSpec = { ...HR_DOMAIN_SPEC, openingActions: undefined } as typeof HR_DOMAIN_SPEC;
    const voice = buildEmployeeIntentDiscoveryMessageForVoice(noActionsSpec, "Krishna", new Date(2026, 6, 31, 9, 0));
    expect(voice).toBe("Good morning, Krishna! What can I help you with?");
  });
});
const TRAVEL_DOMAIN_SPEC = {
  slug: "travel-employee"
} as unknown as Parameters<typeof detectOutOfScopeEmployee>[0];

describe("parseAttachmentBlocks", () => {
  it("parses one or more attachment blocks with filename, mime type and content", () => {
    const text = [
      "[Attachment: leave-policy.pdf (application/pdf)]",
      "Company leave policy: 20 days casual leave per year.",
      "",
      "[Attachment: onboarding.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
      "New joiner onboarding checklist."
    ].join("\n\n");
    const blocks = parseAttachmentBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.filename).toBe("leave-policy.pdf");
    expect(blocks[0]?.content).toMatch(/20 days casual leave/i);
    expect(blocks[1]?.filename).toBe("onboarding.docx");
  });

  it("returns no blocks for ordinary text", () => {
    expect(parseAttachmentBlocks("what is the leave policy?")).toHaveLength(0);
  });
});

describe("summarizeAttachmentText", () => {
  it("returns the first few sentences without inventing content", () => {
    const summary = summarizeAttachmentText("GST show-cause notice dated 12 Aug 2026. Response due 26 Aug.");
    expect(summary).toMatch(/GST show-cause notice/i);
    expect(summary.length).toBeLessThan(300);
  });

  it("handles unreadable/empty text honestly", () => {
    expect(summarizeAttachmentText("   ")).toMatch(/couldn't be read/i);
  });
});

describe("buildAttachmentReadMessage", () => {
  it("acknowledges reading the document, states its intent, and says it is in scope", () => {
    const message = buildAttachmentReadMessage(HR_DOMAIN_SPEC, [
      { filename: "leave-policy.pdf", mimeType: "application/pdf", content: "Leave policy allows 20 days." }
    ]);
    expect(message).toMatch(/I've read your attached document/i);
    expect(message).toMatch(/document is about/i);
    expect(message).toMatch(/related to HR Employee/i);
    expect(message).toMatch(/if it's not relevant to me/i);
  });

  it("routes an out-of-scope document to the correct employee", () => {
    const message = buildAttachmentReadMessage(HR_DOMAIN_SPEC, [
      { filename: "expense.jpg", mimeType: "image/jpeg", content: "Client dinner expense invoice." }
    ]);
    expect(message).toMatch(/Finance Employee/i);
    expect(message).toMatch(/route it to the relevant employee/i);
  });
});

describe("detectOutOfScopeEmployee", () => {
  it("routes a travel request away from the Legal employee to the Travel Employee", () => {
    const target = detectOutOfScopeEmployee(LEGAL_DOMAIN_SPEC, "I want to plan a trip to Dubai");
    expect(target).not.toBeNull();
    expect(target?.displayName).toBe("Travel Employee");
  });

  it("routes an expense question away from HR to the Finance Employee", () => {
    const target = detectOutOfScopeEmployee(HR_DOMAIN_SPEC, "I need help classifying an expense");
    expect(target).not.toBeNull();
    expect(target?.displayName).toBe("Finance Employee");
  });

  it("routes an explicit 'HR employee' mention from the Travel employee to HR", () => {
    const target = detectOutOfScopeEmployee(
      TRAVEL_DOMAIN_SPEC,
      "yeh kaam HR employee se karna hai"
    );
    expect(target).not.toBeNull();
    expect(target?.displayName).toBe("HR Employee");
  });

  it("routes a reimbursement claim for a food bill away from the Travel employee to Finance", () => {
    const target = detectOutOfScopeEmployee(
      TRAVEL_DOMAIN_SPEC,
      "mujhe ye bill food ke liye reimbursement claim karna hai"
    );
    expect(target).not.toBeNull();
    expect(target?.displayName).toBe("Finance Employee");
  });

  it("does NOT route a plain travel meal preference away from the Travel employee to Finance", () => {
    const target = detectOutOfScopeEmployee(TRAVEL_DOMAIN_SPEC, "I prefer veg food");
    expect(target).toBeNull();
  });

  it("does NOT route an in-domain legal question away from the Legal employee", () => {
    const target = detectOutOfScopeEmployee(LEGAL_DOMAIN_SPEC, "how do I draft a reply to a GST notice?");
    expect(target).toBeNull();
  });

  it("does NOT route a leave policy question away from HR", () => {
    const target = detectOutOfScopeEmployee(HR_DOMAIN_SPEC, "what is the leave policy?");
    expect(target).toBeNull();
  });

  it("does NOT route short confirmations or bare replies", () => {
    expect(detectOutOfScopeEmployee(HR_DOMAIN_SPEC, "yes")).toBeNull();
    expect(detectOutOfScopeEmployee(FINANCE_DOMAIN_SPEC, "no")).toBeNull();
    expect(detectOutOfScopeEmployee(LEGAL_DOMAIN_SPEC, "thanks")).toBeNull();
  });
});

describe("detectRoutingConfirmation", () => {
  const offerMessage = buildOutOfScopeRoutingMessage(TRAVEL_DOMAIN_SPEC, {
    slug: "hr-employee",
    displayName: "HR Employee",
    keywords: []
  });

  it("confirms a routing offer accepted with 'yes', carrying over the ORIGINAL out-of-scope message", () => {
    const result = detectRoutingConfirmation(TRAVEL_DOMAIN_SPEC, [
      { role: "assistant", content: "Hi! May I know your name?" },
      { role: "user", content: "need to apply leave" },
      { role: "assistant", content: offerMessage },
      { role: "user", content: "yes" }
    ]);
    expect(result?.target.displayName).toBe("HR Employee");
    expect(result?.originalText).toBe("need to apply leave");
  });

  it("confirms a routing offer accepted with 'route it'", () => {
    const result = detectRoutingConfirmation(TRAVEL_DOMAIN_SPEC, [
      { role: "user", content: "need to apply leave" },
      { role: "assistant", content: offerMessage },
      { role: "user", content: "route it" }
    ]);
    expect(result?.target.displayName).toBe("HR Employee");
    expect(result?.originalText).toBe("need to apply leave");
  });

  it("returns null when the user declines the offer", () => {
    const result = detectRoutingConfirmation(TRAVEL_DOMAIN_SPEC, [
      { role: "user", content: "need to apply leave" },
      { role: "assistant", content: offerMessage },
      { role: "user", content: "no thanks" }
    ]);
    expect(result).toBeNull();
  });

  it("returns null when the prior assistant turn was not a routing offer", () => {
    const result = detectRoutingConfirmation(TRAVEL_DOMAIN_SPEC, [
      { role: "assistant", content: "How may I help you today?" },
      { role: "user", content: "yes" }
    ]);
    expect(result).toBeNull();
  });

  it("returns null for an ordinary affirmative reply mid-conversation (no offer preceded it)", () => {
    const result = detectRoutingConfirmation(TRAVEL_DOMAIN_SPEC, [
      { role: "assistant", content: "Would you like a window seat?" },
      { role: "user", content: "yes" }
    ]);
    expect(result).toBeNull();
  });
});

describe("employeeScopeProfile", () => {
  it("returns the profile for a known slug and null otherwise", () => {
    expect(employeeScopeProfile("legal-employee")?.displayName).toBe("Legal Employee");
    expect(employeeScopeProfile("not-an-employee")).toBeNull();
  });
});

describe("buildOutOfScopeRoutingMessage", () => {
  it("says it is outside scope and routes to the correct employee", () => {
    const travel = employeeScopeProfile("travel-employee");
    if (!travel) throw new Error("travel profile missing");
    const message = buildOutOfScopeRoutingMessage(LEGAL_DOMAIN_SPEC, travel);
    expect(message).toMatch(/outside my scope/i);
    expect(message).toMatch(/route/i);
    expect(message).toMatch(/Travel Employee/i);
  });
});

describe("looksLikeAQuestion", () => {
  it("is true for questions and longer statements, false for short replies", () => {
    expect(looksLikeAQuestion("what is the leave policy?")).toBe(true);
    expect(looksLikeAQuestion("I need help with my laptop")).toBe(true);
    expect(looksLikeAQuestion("leave")).toBe(false);
    expect(looksLikeAQuestion("yes")).toBe(false);
    expect(looksLikeAQuestion("thanks")).toBe(false);
  });
});
