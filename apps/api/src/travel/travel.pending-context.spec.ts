import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  TravelEmployeeProvider,
  arbitrateConversationTurn,
  type ConversationTurnContext
} from "./travel.runtime";

/**
 * Sprint 6.6 — Parts 13-16/23/30/38: `arbitrateConversationTurn` is the single function both the no-LLM
 * `TravelEmployeeProvider` and the LLM-orchestrator `TravelEmployeeLlmOrchestrator` call to decide what a
 * turn means while a specific question is pending — so a fix here is automatically deterministic/LLM-path
 * parity (brief Part 19), not something that needs to be duplicated per engine.
 */

function context(overrides: Partial<ConversationTurnContext> = {}): ConversationTurnContext {
  return { ...overrides };
}

describe("arbitrateConversationTurn — pending contact does not steal corrections/pivots (Sprint 6.6)", () => {
  describe("AWAITING_LEAD_CONTACT", () => {
    const pending = { pendingInputAction: "AWAITING_LEAD_CONTACT" as const };

    it("a genuine bare decline still pauses the pending contact request", () => {
      const result = arbitrateConversationTurn("nahi", context(pending));
      expect(result.intent).toBe("PAUSE_PENDING_ACTION");
      expect(result.preservePendingAction).toBe(false);
    });

    it('"no thanks" is a farewell/graceful-close, not a hard PAUSE (pre-existing FAREWELL_PHRASE behavior)', () => {
      const result = arbitrateConversationTurn("no thanks", context(pending));
      expect(result.intent).toBe("ACKNOWLEDGEMENT");
    });

    it('a correction stated with "nahi" mid-sentence is NOT read as declining the phone request (Part 23)', () => {
      const result = arbitrateConversationTurn("Dubai nahi, Singapore kar do", context(pending));
      expect(result.intent).not.toBe("PAUSE_PENDING_ACTION");
      expect(result.preservePendingAction).toBe(true);
    });

    it('an explicit English correction ("actually...") is not read as a decline (Part 16)', () => {
      const result = arbitrateConversationTurn("Actually change the destination to Singapore", context(pending));
      expect(result.intent).not.toBe("PAUSE_PENDING_ACTION");
      expect(result.preservePendingAction).toBe(true);
    });

    it('a domain pivot ("leave this, salary ka issue hai") is not read as a decline (Part 15)', () => {
      const result = arbitrateConversationTurn("Leave this. Mujhe HR se salary ke baare mein baat karni hai.", context(pending));
      expect(result.intent).not.toBe("PAUSE_PENDING_ACTION");
      expect(result.preservePendingAction).toBe(true);
    });

    it("a phone number is still recognized as answering the pending request", () => {
      const result = arbitrateConversationTurn("+919876543210", context(pending));
      expect(result.intent).toBe("PROVIDE_CONTACT");
      expect(result.answersPendingAction).toBe(true);
    });

    it("a farewell is acknowledged without pausing the pending request as a hard decline", () => {
      const result = arbitrateConversationTurn("thanks, that's all", context(pending));
      expect(result.intent).toBe("ACKNOWLEDGEMENT");
    });
  });

  describe("CONFIRM_STANDALONE_CONTACT_USE", () => {
    const pending = {
      pendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE" as const,
      pendingContactValue: "+919876543210"
    };

    it("an affirmative reply confirms use of the volunteered contact", () => {
      const result = arbitrateConversationTurn("haan", context(pending));
      expect(result.intent).toBe("CONFIRM_STANDALONE_CONTACT_USE");
    });

    it("a genuine bare decline still declines the confirmation", () => {
      const result = arbitrateConversationTurn("nahi", context(pending));
      expect(result.intent).toBe("DECLINE_STANDALONE_CONTACT_USE");
    });

    it('a correction stated with "nahi" is NOT read as declining the contact confirmation', () => {
      const result = arbitrateConversationTurn("Dubai nahi, Singapore kar do", context(pending));
      expect(result.intent).not.toBe("DECLINE_STANDALONE_CONTACT_USE");
    });

    it("a domain pivot is not read as declining the contact confirmation", () => {
      const result = arbitrateConversationTurn("Forget this, salary ka issue hai", context(pending));
      expect(result.intent).not.toBe("DECLINE_STANDALONE_CONTACT_USE");
    });
  });
});

describe("arbitrateConversationTurn — boolean replies across every pending type (Sprint 6.6 Part 30)", () => {
  const affirmatives = ["yes", "haan", "han", "haan ji", "ji"];
  const negatives = ["no", "nahi", "nahin", "nhi", "nope"];

  it.each(affirmatives)('"%s" confirms CONFIRM_STANDALONE_CONTACT_USE', (text) => {
    const result = arbitrateConversationTurn(text, {
      pendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE",
      pendingContactValue: "+919876543210"
    });
    expect(result.intent).toBe("CONFIRM_STANDALONE_CONTACT_USE");
  });

  it.each(negatives)('"%s" declines CONFIRM_STANDALONE_CONTACT_USE', (text) => {
    const result = arbitrateConversationTurn(text, {
      pendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE",
      pendingContactValue: "+919876543210"
    });
    expect(result.intent).toBe("DECLINE_STANDALONE_CONTACT_USE");
  });

  it.each(negatives)('bare "%s" pauses AWAITING_LEAD_CONTACT', (text) => {
    const result = arbitrateConversationTurn(text, { pendingInputAction: "AWAITING_LEAD_CONTACT" });
    expect(result.intent).toBe("PAUSE_PENDING_ACTION");
  });
});

describe("TravelEmployeeProvider — STANDALONE_CONTACT_DECLINED parity (Sprint 6.6 Part 7)", () => {
  it("declining a volunteered phone number's confirmation ends the offer gracefully instead of being silently ignored", async () => {
    const provider = new TravelEmployeeProvider(DEFAULT_TRAVEL_EMPLOYEE_CONFIG);
    const searchTools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} },
      { name: "travel.escalate", description: "", inputSchema: {} }
    ];
    const offer = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: DEFAULT_TRAVEL_EMPLOYEE_CONFIG.welcomeMessage },
        { role: "user", content: "My name is Alex" },
        { role: "assistant", content: "How may I help you today?" },
        { role: "user", content: "You can reach me on +919876543210" }
      ],
      tools: searchTools
    });
    // Volunteering a phone unprompted asks for confirmation before using it — not this test's subject,
    // just the setup for the decline that follows.
    expect(offer.content).toMatch(/\+919876543210|use it|callback|create a travel enquiry/i);

    const decline = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: DEFAULT_TRAVEL_EMPLOYEE_CONFIG.welcomeMessage },
        { role: "user", content: "My name is Alex" },
        { role: "assistant", content: "How may I help you today?" },
        { role: "user", content: "You can reach me on +919876543210" },
        { role: "assistant", content: offer.content },
        { role: "user", content: "no" }
      ],
      tools: searchTools
    });
    // Sprint 6.5's report flagged this as unhandled — the decline used to fall straight through to
    // ordinary message processing instead of acknowledging it. Bringing it to parity with
    // TravelEmployeeLlmOrchestrator's own existing handling means it now gets a graceful close instead.
    expect(decline.toolCalls).toEqual([]);
    expect(decline.content).not.toMatch(/where would you like to travel|what can i help you with/i);
  });
});
