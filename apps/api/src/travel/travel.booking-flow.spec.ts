/**
 * Regression coverage for the "Travel Employee booking flow" fix: the deterministic
 * `TravelEmployeeProvider`'s booking-intent routing must show three structured, selectable simulated
 * options, require an explicit Option 1/2/3 selection, require an explicit "Confirm booking" reply, and
 * only THEN emit a `START_BOOKING_HANDOFF` workflow signal — never book on the first "book my flight".
 * Drives the exact trip state from the failed UAT conversation (Krishna, Delhi -> Dubai, 2026-08-12,
 * 5 days, 3 adults, ROUND_TRIP, AED 100000, vegetarian) as `priorEntities`, matching the constructor
 * fixture pattern `travel.runtime.spec.ts` already uses for the deterministic provider.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  TravelEmployeeProvider,
  type TravelEmployeeRuntimeConfig,
  type TravelEntities
} from "./travel.runtime";

const config: TravelEmployeeRuntimeConfig = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

const KRISHNA_ENTITIES: TravelEntities = {
  ...EMPTY_TRAVEL_ENTITIES,
  customerName: "Krishna",
  originCity: "Delhi",
  destinationCity: "Dubai",
  departureDate: "2026-08-12",
  days: 5,
  adults: 3,
  tripType: "ROUND_TRIP",
  budget: 100000,
  budgetCurrency: "AED",
  preferences: ["vegetarian"]
};

const NAME_MESSAGE = { role: "user" as const, content: "My name is Krishna" };
const BOOKING_MESSAGE = { role: "user" as const, content: "book hotel and flight both" };
const PASSENGER_DETAILS_MESSAGE = {
  role: "user" as const,
  content: "1. Krishna Pandey, 34, Male; 2. Anita Pandey, 32, Female; 3. Rohan Pandey, 8, Male"
};
const TICKET_CONTACT_MESSAGE = { role: "user" as const, content: "krishna@example.com" };

describe("TravelEmployeeProvider booking flow: options -> selection -> confirmation -> workflow signal", () => {
  it("shows three structured Option 1/2/3 packages on the first booking-intent turn, without booking immediately", async () => {
    const provider = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    const result = await provider.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });

    expect(result.content).toMatch(/Option 1 — Value/);
    expect(result.content).toMatch(/Option 2 — Recommended/);
    expect(result.content).toMatch(/Option 3 — Premium/);
    expect(result.content).toMatch(/Value, Recommended, or Premium/);
    expect(provider.lastMemory.pendingAction).toBe("AWAITING_OPTION_SELECTION");
    expect(provider.lastMemory.pendingRecommendations).toHaveLength(3);
    // No booking is ever started merely by showing options.
    expect(provider.lastWorkflowSignal).toBeNull();
  });

  it("'book my flight' once options are already pending re-prompts for a selection instead of re-booking or repeating price ranges", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });

    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    const result = await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Book my flight" }]
    });
    expect(result.content).toMatch(/value, recommended, or premium/i);
    expect(second.lastMemory.pendingAction).toBe("AWAITING_OPTION_SELECTION");
    expect(second.lastWorkflowSignal).toBeNull();
  });

  it("selecting an option asks for every traveller's name/age/gender before any booking summary — a real ticket can't name 'Passenger 1'/'Passenger 2'", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });

    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    const result = await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });

    expect(result.content).toMatch(/full name, age and gender/i);
    expect(result.content).not.toMatch(/\(\d+ total\)/);
    expect(second.lastMemory.pendingAction).toBe("AWAITING_PASSENGER_DETAILS");
    expect(second.lastMemory.selectedRecommendationId).toBeTruthy();
    expect(second.lastWorkflowSignal).toBeNull();
  });

  it("a partial passenger list re-prompts for just the remaining travellers, listing what's already recorded", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });
    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });

    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    const result = await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        { role: "user", content: "1. Krishna Pandey, 34, Male; 2. Anita Pandey, 32, Female" }
      ]
    });

    expect(result.content).toMatch(/the last traveller/i);
    expect(result.content).toMatch(/Krishna Pandey, 34, MALE/);
    expect(result.content).toMatch(/Anita Pandey, 32, FEMALE/);
    expect(third.lastMemory.pendingAction).toBe("AWAITING_PASSENGER_DETAILS");
    expect(third.lastMemory.passengerDetails).toHaveLength(2);
  });

  it("once every traveller is recorded, asks where to send the ticket before showing any booking summary", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });
    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });

    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    const result = await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE
      ]
    });

    // Fix (Travel Booking Closure Pass — Phase 17): natural phrasing — see
    // buildTicketContactRequestMessage's own doc comment; email/WhatsApp/"skip"/chat-download replies all
    // still parse exactly as before (Phase 3's broadened resolvesTicketDeliveryQuestion).
    expect(result.content).toMatch(/would you like the ticket here in chat, by email, or on whatsapp/i);
    expect(third.lastMemory.pendingAction).toBe("AWAITING_TICKET_CONTACT");
    expect(third.lastMemory.passengerDetails).toHaveLength(3);
    expect(third.lastWorkflowSignal).toBeNull();
  });

  it("providing an email for the ticket then shows the final booking-confirmation summary listing every traveller, still without booking", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });
    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });
    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE
      ]
    });

    const fourth = new TravelEmployeeProvider(config, third.lastMemory, KRISHNA_ENTITIES);
    const result = await fourth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        TICKET_CONTACT_MESSAGE
      ]
    });

    expect(result.content).toMatch(/Please confirm your simulated booking/);
    expect(result.content).toMatch(/Delhi.*Dubai.*Delhi/s);
    expect(result.content).toMatch(/3 traveller\(s\)/);
    expect(result.content).toMatch(/Food preference: Vegetarian/);
    expect(result.content).toMatch(/Krishna Pandey, 34, MALE/);
    expect(result.content).toMatch(/Anita Pandey, 32, FEMALE/);
    expect(result.content).toMatch(/Rohan Pandey, 8, MALE/);
    expect(result.content).toMatch(/Reply 'Confirm booking' to proceed, or 'Change option'/);
    expect(fourth.lastMemory.pendingAction).toBe("AWAITING_BOOKING_CONFIRMATION");
    expect(fourth.lastMemory.passengerDetails).toHaveLength(3);
    expect(fourth.lastMemory.ticketContact).toMatchObject({ email: "krishna@example.com" });
    expect(fourth.lastWorkflowSignal).toBeNull();
  });

  it("replying 'skip' to the ticket-contact prompt proceeds to the confirmation summary anyway, without a contact on file", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });
    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });
    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE
      ]
    });

    const fourth = new TravelEmployeeProvider(config, third.lastMemory, KRISHNA_ENTITIES);
    const result = await fourth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "skip" }
      ]
    });

    expect(result.content).toMatch(/Please confirm your simulated booking/);
    expect(fourth.lastMemory.pendingAction).toBe("AWAITING_BOOKING_CONFIRMATION");
    expect(fourth.lastMemory.ticketContact).toEqual({ email: null, phone: null });
  });

  it("only an explicit 'Confirm booking' after passenger details AND ticket contact emits the START_BOOKING_HANDOFF workflow signal, carrying the full passenger roster and the delivery contact", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });

    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });

    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE
      ]
    });

    const fourth = new TravelEmployeeProvider(config, third.lastMemory, KRISHNA_ENTITIES);
    await fourth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        TICKET_CONTACT_MESSAGE
      ]
    });

    const fifth = new TravelEmployeeProvider(config, fourth.lastMemory, KRISHNA_ENTITIES);
    const result = await fifth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        TICKET_CONTACT_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Confirm booking" }
      ]
    });

    expect(result.content).toMatch(/submitted your booking request/i);
    expect(fifth.lastWorkflowSignal).not.toBeNull();
    expect(fifth.lastWorkflowSignal?.signalType).toBe("START_BOOKING_HANDOFF");
    const payload = fifth.lastWorkflowSignal?.payload as {
      selectedOption?: { optionNumber?: number };
      passengerDetails?: Array<{ name: string; age: number; gender: string }>;
      customerEmail?: string | null;
      customerPhone?: string | null;
    };
    expect(payload.selectedOption?.optionNumber).toBe(2);
    expect(payload.passengerDetails).toHaveLength(3);
    expect(payload.passengerDetails?.[0]).toMatchObject({ name: "Krishna Pandey", age: 34, gender: "MALE" });
    expect(payload.customerEmail).toBe("krishna@example.com");
    expect(payload.customerPhone).toBeNull();
    expect(fifth.lastMemory.pendingAction).toBeNull();
    expect(fifth.lastMemory.passengerDetails).toBeNull();
    expect(fifth.lastMemory.ticketContact).toBeNull();
  });

  it("'Change option' while awaiting passenger details re-shows the SAME persisted options instead of a fresh set", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });

    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });

    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    const result = await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Change option" }
      ]
    });

    expect(result.content).toMatch(/Option 1 — Value/);
    expect(third.lastMemory.pendingAction).toBe("AWAITING_OPTION_SELECTION");
    expect(third.lastMemory.selectedRecommendationId).toBeNull();
    // Same persisted set, not a freshly regenerated one.
    expect(third.lastMemory.pendingRecommendations).toEqual(first.lastMemory.pendingRecommendations);
  });

  it("re-selecting an option after passenger details were already fully recorded skips straight back to the ticket-contact prompt (still pending), then the confirmation summary once that's answered", async () => {
    const first = new TravelEmployeeProvider(config, undefined, KRISHNA_ENTITIES);
    await first.complete({ messages: [NAME_MESSAGE, BOOKING_MESSAGE] });
    const second = new TravelEmployeeProvider(config, first.lastMemory, KRISHNA_ENTITIES);
    await second.complete({
      messages: [NAME_MESSAGE, BOOKING_MESSAGE, { role: "assistant", content: "..." }, { role: "user", content: "Option 2" }]
    });
    const third = new TravelEmployeeProvider(config, second.lastMemory, KRISHNA_ENTITIES);
    await third.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE
      ]
    });
    const fourth = new TravelEmployeeProvider(config, third.lastMemory, KRISHNA_ENTITIES);
    await fourth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Change option" }
      ]
    });

    const fifth = new TravelEmployeeProvider(config, fourth.lastMemory, KRISHNA_ENTITIES);
    const result = await fifth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Change option" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 3" }
      ]
    });

    // Fix (Travel Booking Closure Pass — Phase 17): natural phrasing — see
    // buildTicketContactRequestMessage's own doc comment; email/WhatsApp/"skip"/chat-download replies all
    // still parse exactly as before (Phase 3's broadened resolvesTicketDeliveryQuestion).
    expect(result.content).toMatch(/would you like the ticket here in chat, by email, or on whatsapp/i);
    expect(fifth.lastMemory.pendingAction).toBe("AWAITING_TICKET_CONTACT");
    expect(fifth.lastMemory.passengerDetails).toHaveLength(3);

    const sixth = new TravelEmployeeProvider(config, fifth.lastMemory, KRISHNA_ENTITIES);
    const finalResult = await sixth.complete({
      messages: [
        NAME_MESSAGE,
        BOOKING_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 2" },
        { role: "assistant", content: "..." },
        PASSENGER_DETAILS_MESSAGE,
        { role: "assistant", content: "..." },
        { role: "user", content: "Change option" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Option 3" },
        { role: "assistant", content: "..." },
        TICKET_CONTACT_MESSAGE
      ]
    });

    expect(finalResult.content).toMatch(/Please confirm your simulated booking/);
    expect(finalResult.content).toMatch(/Krishna Pandey, 34, MALE/);
    expect(sixth.lastMemory.pendingAction).toBe("AWAITING_BOOKING_CONFIRMATION");
  });
});
