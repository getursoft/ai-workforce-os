/**
 * Regression coverage for the "resend my ticket" conversational flow in the deterministic
 * TravelEmployeeProvider — a returning customer, possibly in a brand-new conversation with no prior trip
 * state, asking for their ticket again by sharing their name/email/travel date.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  TravelEmployeeProvider,
  entitiesToStoredState,
  memoryFromStoredState,
  entitiesFromStoredState,
  type TravelEmployeeRuntimeConfig
} from "./travel.runtime";

const config: TravelEmployeeRuntimeConfig = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

describe("TravelEmployeeProvider: resend-ticket flow", () => {
  it("works in a BRAND NEW conversation, before the traveler has re-introduced themselves — checked ahead of the name-collection gate", async () => {
    const provider = new TravelEmployeeProvider(config, undefined, EMPTY_TRAVEL_ENTITIES);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Can you resend my ticket? My email is krishna@example.com and I travelled on 12 August 2026" }]
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.resend_ticket");
    const args = result.toolCalls[0]?.arguments as { email: string; travelDate: string | null };
    expect(args.email).toBe("krishna@example.com");
    expect(args.travelDate).toBe("2026-08-12");
  });

  it("asks for the email when a resend request doesn't include one, and remembers it's pending across turns", async () => {
    const first = new TravelEmployeeProvider(config, undefined, EMPTY_TRAVEL_ENTITIES);
    const result = await first.complete({ messages: [{ role: "user", content: "can you resend my ticket please" }] });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toMatch(/email address/i);
    expect(first.lastMemory.pendingAction).toBe("AWAITING_RESEND_TICKET_DETAILS");
  });

  it("accepts the email on a later turn (no resend keywords needed once already pending) and fires the tool call", async () => {
    const first = new TravelEmployeeProvider(config, undefined, EMPTY_TRAVEL_ENTITIES);
    await first.complete({ messages: [{ role: "user", content: "can you resend my ticket please" }] });

    const second = new TravelEmployeeProvider(config, first.lastMemory, EMPTY_TRAVEL_ENTITIES);
    const result = await second.complete({
      messages: [
        { role: "user", content: "can you resend my ticket please" },
        { role: "assistant", content: "..." },
        { role: "user", content: "krishna@example.com" }
      ]
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.resend_ticket");
    const args = result.toolCalls[0]?.arguments as { email: string; travelDate: string | null };
    expect(args.email).toBe("krishna@example.com");
    expect(args.travelDate).toBeNull();
    expect(second.lastMemory.pendingAction).toBeNull();
  });

  it("survives a full memory serialize/deserialize round-trip (the exact bug class found earlier with passengerDetails)", async () => {
    const first = new TravelEmployeeProvider(config, undefined, EMPTY_TRAVEL_ENTITIES);
    await first.complete({ messages: [{ role: "user", content: "can you resend my ticket please" }] });

    // Round-trip through the same serialize/deserialize path AgentService uses between HTTP turns.
    const stored = entitiesToStoredState(first.lastEntities, "DISCOVER_INTENT", first.lastMemory);
    const restoredMemory = memoryFromStoredState(stored as Record<string, unknown>);
    const restoredEntities = entitiesFromStoredState(stored as Record<string, unknown>);

    expect(restoredMemory.pendingAction).toBe("AWAITING_RESEND_TICKET_DETAILS");

    const second = new TravelEmployeeProvider(config, restoredMemory, restoredEntities);
    const result = await second.complete({
      messages: [{ role: "user", content: "krishna@example.com" }]
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.resend_ticket");
  });

  it("interprets a found tool result into a confirmation naming the real channels used", async () => {
    const provider = new TravelEmployeeProvider(config, EMPTY_TRAVEL_CONVERSATION_MEMORY, EMPTY_TRAVEL_ENTITIES);
    const toolOutput = JSON.stringify({ resendResult: true, found: true, pnr: "ABC123", emailStatus: "SENT", whatsappStatus: null });
    const result = await provider.complete({
      messages: [
        { role: "user", content: "resend my ticket, krishna@example.com" },
        { role: "assistant", content: "", toolCallId: "call-1" },
        { role: "tool", content: toolOutput, toolCallId: "call-1" }
      ]
    });
    expect(result.content).toMatch(/ABC123/);
    expect(result.content).toMatch(/via email/);
  });

  it("interprets a not-found tool result honestly, never claiming a match", async () => {
    const provider = new TravelEmployeeProvider(config, EMPTY_TRAVEL_CONVERSATION_MEMORY, EMPTY_TRAVEL_ENTITIES);
    const toolOutput = JSON.stringify({ resendResult: true, found: false });
    const result = await provider.complete({
      messages: [
        { role: "user", content: "resend my ticket, nobody@example.com" },
        { role: "assistant", content: "", toolCallId: "call-1" },
        { role: "tool", content: toolOutput, toolCallId: "call-1" }
      ]
    });
    expect(result.content).toMatch(/couldn't find/i);
  });
});
