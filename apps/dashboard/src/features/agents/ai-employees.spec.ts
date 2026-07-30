import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-error";
import {
  agentRunErrorMessage,
  conversationStorageKey,
  decideConversationEntry,
  derivePlaceholder,
  knowledgeSourceLabel,
  toLocalMessages
} from "./agent-pages";
import type { ConversationMessage } from "./agent-api";

describe("AI Employees runtime errors", () => {
  it.each([
    ["AI_PROVIDER_AUTHENTICATION_FAILED", "credentials were rejected"],
    ["AI_PROVIDER_MODEL_NOT_FOUND", "model is unavailable"],
    ["AI_PROVIDER_QUOTA_EXCEEDED", "quota has been exceeded"],
    ["AI_PROVIDER_UNAVAILABLE", "currently unavailable"],
    ["AI_PROVIDER_TEST_FAILED", "could not complete"],
    ["AI_PROVIDER_RESPONSE_INVALID", "invalid response"],
    ["AGENT_EXECUTION_FAILED", "could not be completed safely"]
  ])("displays a stable message for %s", (code, expected) => {
    expect(
      agentRunErrorMessage(new ApiError({ kind: "server", code, message: "Unsafe backend detail" }))
    ).toContain(expected);
  });
});

describe("AI employee enterprise knowledge sources", () => {
  it("renders document, page or chunk, and relevance without exposing embeddings", () => {
    expect(
      knowledgeSourceLabel({
        title: "Travel Policy.pdf",
        pageNumber: 4,
        chunkIndex: 8,
        score: 0.84
      })
    ).toBe("Travel Policy.pdf — page 4 (84% relevance)");
    expect(
      knowledgeSourceLabel({
        title: "Visa SOP.docx",
        pageNumber: null,
        chunkIndex: 2,
        score: 0.7
      })
    ).toBe("Visa SOP.docx — chunk 3 (70% relevance)");
  });
});

describe("conversationStorageKey", () => {
  it("is namespaced per plugin installation, so different AI employees never share a stored conversation", () => {
    expect(conversationStorageKey("plugin-a")).not.toBe(conversationStorageKey("plugin-b"));
    expect(conversationStorageKey("plugin-a")).toBe(conversationStorageKey("plugin-a"));
  });
});

describe("decideConversationEntry (session isolation — reproduces and fixes the UAT bug)", () => {
  it("greets fresh with no prompt when nothing was stored — the normal first-ever visit", () => {
    expect(decideConversationEntry(null)).toEqual({ action: "GREET_NEW" });
  });

  it("never auto-resumes a stored conversation — it must always ask the user first, exactly the bug where a brand-new conversation silently inherited the previous customer's name", () => {
    const decision = decideConversationEntry("conversation-with-krishna");
    expect(decision).toEqual({
      action: "ASK_RESUME_OR_NEW",
      storedConversationId: "conversation-with-krishna"
    });
    // Never GREET_NEW and never any variant that skips the explicit choice.
    expect(decision.action).not.toBe("GREET_NEW");
  });
});

describe("toLocalMessages (hydrating a reopened conversation)", () => {
  const row = (role: ConversationMessage["role"], content: string): ConversationMessage => ({
    id: `${role}-${content}`,
    role,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    toolExecutionId: null
  });

  it("keeps USER and ASSISTANT turns in order", () => {
    const rows = [row("USER", "Krishna"), row("ASSISTANT", "Nice to meet you, Krishna.")];
    expect(toLocalMessages(rows)).toEqual([
      { role: "USER", content: "Krishna" },
      { role: "ASSISTANT", content: "Nice to meet you, Krishna." }
    ]);
  });

  it("drops SYSTEM and TOOL rows, and any row with empty content — never a synthetic or blank bubble", () => {
    const rows = [
      row("SYSTEM", "internal prompt"),
      row("USER", ""),
      row("TOOL", '{"result":true}'),
      row("ASSISTANT", "Hi 👋, I am your travel companion. May I know your name, please?")
    ];
    expect(toLocalMessages(rows)).toEqual([
      { role: "ASSISTANT", content: "Hi 👋, I am your travel companion. May I know your name, please?" }
    ]);
  });

  it("returns an empty array for an empty transcript", () => {
    expect(toLocalMessages([])).toEqual([]);
  });
});

describe("derivePlaceholder (Travel Employee onboarding-stage-aware input placeholder)", () => {
  it("asks for the traveler's name before the stage is known, or while still in GREETING/COLLECT_NAME", () => {
    expect(derivePlaceholder(null)).toBe("Type your name...");
    expect(derivePlaceholder(undefined)).toBe("Type your name...");
    expect(derivePlaceholder("GREETING")).toBe("Type your name...");
    expect(derivePlaceholder("COLLECT_NAME")).toBe("Type your name...");
  });
  it("asks how it can help once the name is known but intent hasn't been discovered yet", () => {
    expect(derivePlaceholder("DISCOVER_INTENT")).toBe("How can I help you with your travel?");
  });
  it("asks for the destination once intent is known but the destination is still unknown", () => {
    expect(derivePlaceholder("COLLECT_DESTINATION")).toBe("Tell me where you'd like to travel...");
  });
  it("asks a question-oriented placeholder whenever the most recent reply was knowledge-grounded, regardless of trip-planning stage underneath", () => {
    expect(derivePlaceholder("COLLECT_DESTINATION", true)).toBe("Ask your travel question...");
    expect(derivePlaceholder("COLLECT_BUDGET", true)).toBe("Ask your travel question...");
    // Onboarding still takes priority over a stale/irrelevant knowledge-sources flag.
    expect(derivePlaceholder("COLLECT_NAME", true)).toBe("Type your name...");
  });
  it("falls back to a general trip-planning placeholder for every later stage", () => {
    for (const stage of [
      "COLLECT_DATES",
      "COLLECT_PASSENGERS",
      "COLLECT_BUDGET",
      "ASK_MISSING_INFO",
      "RECOMMEND_OPTIONS",
      "ITINERARY_SUMMARY",
      "CONFIRM_BOOKING",
      "BOOKING_CONFIRMED",
      "ESCALATED"
    ] as const) {
      expect(derivePlaceholder(stage)).toBe("Tell me more about your trip...");
    }
  });
});
