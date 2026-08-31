import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_ENTITY_CONFIRMATION,
  TravelEmployeeProvider,
  arbitrateConversationTurn,
  buildCrmLeadPayload,
  buildIntentDiscoveryMessage,
  deriveTravelState,
  extractBudget,
  extractCustomerName,
  extractDestination,
  extractDurationDays,
  extractPassengers,
  extractPassengerComposition,
  extractTravelMonth,
  extractTravelSlots,
  generatePlaceholderFlights,
  generatePlaceholderHotels,
  isBookingConfirmation,
  isEscalationRequest,
  isIntentDiscoveryPending,
  looksLikePhoneOrContact,
  mergeConfirmedEntities,
  normalizeCityName,
  parsePendingDepartureDate,
  reconcileJourneyLegs,
  toJourneyLeg,
  missingFields,
  reconcileRouteFromMessage,
  resolveTravelInput,
  timeOfDayGreeting,
  TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT,
  wasBookingConfirmed,
  wasEscalated,
  wasItineraryPresented,
  entitiesToStoredState,
  memoryFromStoredState,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  isResendTicketRequest,
  extractEmailAddress,
  extractResendTicketDate,
  buildResendTicketReply,
  detectExplicitFieldCorrection,
  hasMaterialPackageChange,
  extractOriginCity,
  resolveOriginReplyDeterministically,
  deterministicExtractFallback,
  type TravelEmployeeRuntimeConfig
} from "./travel.runtime";

function requireId(call: { id: string } | undefined): string {
  if (!call) throw new Error("expected a tool call");
  return call.id;
}

describe("entitiesToStoredState / memoryFromStoredState: passengerDetails round-trips across turns", () => {
  it("survives a full serialize -> deserialize cycle (reproduces a real bug: entitiesToStoredState enumerates memory fields explicitly rather than spreading, so a new memory field is silently dropped between HTTP turns unless listed there too)", () => {
    const memory = {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      passengerDetails: [
        { name: "Krishna Pandey", age: 34, gender: "MALE" as const },
        { name: "Anita Pandey", age: 32, gender: "FEMALE" as const }
      ]
    };
    const stored = entitiesToStoredState(EMPTY_TRAVEL_ENTITIES, "COLLECT_NAME", memory);
    const restored = memoryFromStoredState(stored);
    expect(restored.passengerDetails).toEqual(memory.passengerDetails);
  });

  it("round-trips null when no passengers have been collected yet", () => {
    const stored = entitiesToStoredState(EMPTY_TRAVEL_ENTITIES, "COLLECT_NAME", EMPTY_TRAVEL_CONVERSATION_MEMORY);
    const restored = memoryFromStoredState(stored);
    expect(restored.passengerDetails).toBeNull();
  });
});

describe("slot extraction", () => {
  it("extracts a known destination case-insensitively", () => {
    expect(extractDestination("I want to plan a trip to dubai please")).toBe("Dubai");
    expect(extractDestination("Paris sounds nice")).toBe("Paris");
  });
  it("falls back to a capitalized 'to <Place>' pattern for unknown destinations", () => {
    expect(extractDestination("I'd like to visit Reykjavik")).toBe("Reykjavik");
  });
  it("returns null when no destination is present", () => {
    expect(extractDestination("hello there")).toBeNull();
  });
  it("extracts a travel month", () => {
    expect(extractTravelMonth("sometime in December works for us")).toBe("December");
    expect(extractTravelMonth("no month here")).toBeNull();
  });
  it("extracts a travel month from a common abbreviation (reproduces the 'Sept'/'Oct'/'Nov' UAT bug, which left the assistant re-asking 'which month?' forever)", () => {
    expect(extractTravelMonth("10 Sept 2026")).toBe("September");
    expect(extractTravelMonth("10 sep 2026")).toBe("September");
    expect(extractTravelMonth("1 Oct 2026")).toBe("October");
    expect(extractTravelMonth("5 Nov 2026")).toBe("November");
    expect(extractTravelMonth("Jan 3rd")).toBe("January");
    expect(extractTravelMonth("dec 25")).toBe("December");
  });
  it("extracts duration in days", () => {
    expect(extractDurationDays("for about 5 days")).toBe(5);
    expect(extractDurationDays("a 10-night trip")).toBeNull();
    expect(extractDurationDays("no duration")).toBeNull();
  });
  it("keeps explicit passenger composition and derives its total", () => {
    expect(extractPassengerComposition("4 rat ke liye jana hai 3 adult 1 kid")).toEqual({
      adults: 3,
      children: 1,
      infants: null,
      totalTravellers: 4
    });
  });
  it.each(["15 August", "15 Aug", "August 15", "15/08"])(
    "persists partial date %j without inventing a year",
    (text) => {
      expect(parsePendingDepartureDate(text)).toMatchObject({ day: 15, month: 8, year: null, source: "USER_EXPLICIT" });
    }
  );
  it("canonicalizes New York and Delhi aliases", () => {
    expect(normalizeCityName("newyork")).toBe("New York");
    expect(normalizeCityName("NYC")).toBe("New York");
    expect(normalizeCityName("New Delhi")).toBe("New Delhi");
  });
  it("extracts passenger counts from digits, words, and 'family of N'", () => {
    expect(extractPassengers("we are 3 adults")).toBe(3);
    expect(extractPassengers("two travelers total")).toBe(2);
    expect(extractPassengers("family of 4")).toBe(4);
    expect(extractPassengers("just chatting")).toBeNull();
  });
  it("routes phone-like input ahead of passenger and numeric parsing", () => {
    expect(looksLikePhoneOrContact("8380031193")).toBe(true);
    expect(extractPassengers("8380031193")).toBeNull();
    expect(extractPassengerComposition("+918380031193")).toEqual({
      adults: null,
      children: null,
      infants: null,
      totalTravellers: null
    });
    expect(
      resolveTravelInput("8380031193", {
        pendingInputAction: null,
        pendingContactValue: null
      })
    ).toEqual({ kind: "STANDALONE_CONTACT", contact: "8380031193" });
  });
  it("typed lead-contact state consumes contact and preserves non-contact acknowledgements", () => {
    expect(
      resolveTravelInput("okay thank you", {
        pendingInputAction: "AWAITING_LEAD_CONTACT",
        pendingContactValue: null
      })
    ).toEqual({ kind: "PENDING_CONTACT_NON_CONTACT" });
    expect(
      resolveTravelInput("+918380031193", {
        pendingInputAction: "AWAITING_LEAD_CONTACT",
        pendingContactValue: null
      })
    ).toEqual({ kind: "PENDING_CONTACT", contact: "+918380031193" });
  });
  it("arbitrates explicit requests before a typed lead-contact expectation", () => {
    const context = {
      pendingInputAction: "AWAITING_LEAD_CONTACT" as const,
      pendingContactValue: null,
      tripState: {
        ...EMPTY_TRAVEL_ENTITIES,
        originCity: "Delhi",
        destinationCity: "Dubai",
        adults: 3,
        days: 4,
        budget: 10_000,
        budgetCurrency: "AED"
      }
    };

    expect(arbitrateConversationTurn("create a full itinerary", context)).toMatchObject({
      intent: "EXPLICIT_TRAVEL_ACTION",
      planningAction: "GENERATE_ITINERARY",
      answersPendingAction: false,
      preservePendingAction: true,
      source: "DETERMINISTIC"
    });
    expect(arbitrateConversationTurn("change it to 2 adults", context)).toMatchObject({
      intent: "PROVIDE_PASSENGER_COMPOSITION",
      answersPendingAction: false,
      preservePendingAction: true
    });
    expect(arbitrateConversationTurn("share the minimal possible budget", context)).toMatchObject({
      intent: "SEMANTIC_CLASSIFICATION_REQUIRED",
      answersPendingAction: false,
      preservePendingAction: true,
      source: "LLM"
    });
    expect(arbitrateConversationTurn("8380031193", context)).toMatchObject({
      intent: "PROVIDE_CONTACT",
      answersPendingAction: true,
      preservePendingAction: false
    });
    expect(arbitrateConversationTurn("thank you", context)).toMatchObject({
      intent: "ACKNOWLEDGEMENT",
      answersPendingAction: false,
      preservePendingAction: true
    });
    expect(arbitrateConversationTurn("not now", context)).toMatchObject({
      intent: "PAUSE_PENDING_ACTION",
      answersPendingAction: true,
      preservePendingAction: false
    });
  });
  it("typed passenger and year actions still accept their own legitimate numeric replies", () => {
    expect(
      resolveTravelInput("5", {
        pendingInputAction: "AWAITING_PASSENGER_COMPOSITION",
        pendingContactValue: null
      })
    ).toEqual({ kind: "PASSENGER_INPUT" });
    expect(
      resolveTravelInput("3 adults 2 children", {
        pendingInputAction: "AWAITING_PASSENGER_COMPOSITION",
        pendingContactValue: null
      })
    ).toEqual({ kind: "PASSENGER_INPUT" });
    expect(
      resolveTravelInput("2027", {
        pendingInputAction: "AWAITING_TRAVEL_YEAR",
        pendingContactValue: null
      })
    ).toEqual({ kind: "DATE_INPUT" });
  });
  it("extracts budgets in lakh, dollar, and rupee notations", () => {
    expect(extractBudget("budget is about 2 lakh")).toEqual({ amount: 200_000, currency: "INR" });
    expect(extractBudget("I can spend $2000")).toEqual({ amount: 2000, currency: "USD" });
    expect(extractBudget("around Rs 50000")).toEqual({ amount: 50_000, currency: "INR" });
    expect(extractBudget("no budget info")).toBeNull();
  });
  it("Stage 9F UAT regression: recognizes postfix '<amount> <currency>' ordering, including AED (previously unsupported at all)", () => {
    expect(extractBudget("10000 AED")).toEqual({ amount: 10_000, currency: "AED" });
    expect(extractBudget("5000 AED")).toEqual({ amount: 5000, currency: "AED" });
    expect(extractBudget("50000 USD")).toEqual({ amount: 50_000, currency: "USD" });
    expect(extractBudget("2000 SGD")).toEqual({ amount: 2000, currency: "SGD" });
  });
  it("never mislabels an unsupported currency's amount as the fallback currency (reproduces the Bali/IDR UAT bug — 'IDR 20000000' is NOT a $20,000,000 budget)", () => {
    expect(extractBudget("budget IDR 20000000", "USD")).toBeNull();
    expect(extractBudget("budget is 6000000 yen", "USD")).toBeNull();
    // A bare number with no currency word at all still falls back to the caller's fallback currency.
    expect(extractBudget("budget is 5000", "USD")).toEqual({ amount: 5000, currency: "USD" });
  });
  it("merges slots across messages without overwriting already-known values", () => {
    const slots = extractTravelSlots([
      "I want to go to Dubai",
      "sometime in December for 5 days",
      "2 adults",
      "budget is $2000"
    ]);
    expect(slots).toEqual({
      destination: "Dubai",
      travelMonth: "December",
      durationDays: 5,
      passengers: 2,
      budgetAmount: 2000,
      budgetCurrency: "USD"
    });
  });
  it("never asks again once a slot is filled, even if a later message repeats a different value", () => {
    const slots = extractTravelSlots(["Dubai please", "actually Paris"]);
    expect(slots.destination).toBe("Dubai");
  });
});

describe("journey correction reconciliation", () => {
  const entity = (
    originCity: string,
    destinationCity: string,
    days: number | null
  ) => ({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Madhav", originCity, destinationCity, days, adults: 3, children: 1, totalTravellers: 4 });

  it("updates destination stays without duplicate legs or duration aggregation", () => {
    const existing = [
      toJourneyLeg(entity("Delhi", "Dubai", 4), null, null, 1),
      toJourneyLeg(entity("Dubai", "New York", null), null, null, 2),
      toJourneyLeg(entity("New York", "Delhi", null), null, null, 3)
    ];
    const corrected = reconcileJourneyLegs(
      existing,
      [
        toJourneyLeg(entity("Delhi", "Dubai", 5), null, null, 4),
        toJourneyLeg(entity("Dubai", "New York", 3), null, null, 5)
      ],
      "Delhi"
    );
    expect(corrected.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual([
      "Delhi->Dubai",
      "Dubai->New York",
      "New York->Delhi"
    ]);
    expect(corrected.map((leg) => leg.duration.days)).toEqual([5, 3, null]);
    expect(corrected.some((leg) => leg.duration.days === 8)).toBe(false);
    expect(corrected[2]?.destinationRole).toBe("FINAL_RETURN");
  });
});

describe("missingFields", () => {
  it("lists only the unset required fields", () => {
    expect(
      missingFields({
        destination: "Dubai",
        travelMonth: null,
        durationDays: null,
        passengers: null,
        budgetAmount: null,
        budgetCurrency: null
      })
    ).toEqual(["travelMonth", "passengers", "budgetAmount"]);
    expect(
      missingFields({
        destination: "Dubai",
        travelMonth: "December",
        durationDays: 5,
        passengers: 2,
        budgetAmount: 2000,
        budgetCurrency: "USD"
      })
    ).toEqual([]);
  });
});

describe("escalation and confirmation detection", () => {
  it("detects escalation requests", () => {
    expect(isEscalationRequest("can I talk to a human")).toBe(true);
    expect(isEscalationRequest("please escalate this")).toBe(true);
    expect(isEscalationRequest("Dubai sounds fun")).toBe(false);
  });
  it("detects booking confirmations", () => {
    expect(isBookingConfirmation("yes please confirm")).toBe(true);
    expect(isBookingConfirmation("book it")).toBe(true);
    expect(isBookingConfirmation("no thanks")).toBe(false);
  });
});

describe("resend-ticket detection and extraction", () => {
  it.each([
    "can you resend my ticket",
    "resend ticket please",
    "please re-send my ticket",
    "send me my ticket again",
    "I need my ticket",
    "I lost my ticket",
    "where's my ticket",
    "can't find my ticket"
  ])("detects a resend-ticket request in %j", (text) => {
    expect(isResendTicketRequest(text)).toBe(true);
  });

  it("does not treat unrelated messages as a resend-ticket request", () => {
    expect(isResendTicketRequest("Plan a trip to Dubai")).toBe(false);
    expect(isResendTicketRequest("book my flight")).toBe(false);
  });

  it("extracts an email address from free text", () => {
    expect(extractEmailAddress("my email is krishna.pandey@example.com, thanks")).toBe("krishna.pandey@example.com");
    expect(extractEmailAddress("no email here")).toBeNull();
  });

  it("extracts an exact resend-lookup date, never a relative phrase", () => {
    expect(extractResendTicketDate("I travelled on 12 August 2026")).toBe("2026-08-12");
    expect(extractResendTicketDate("17 jan 27")).toBe("2027-01-17");
    expect(extractResendTicketDate("next week")).toBeNull();
    expect(extractResendTicketDate("no date here")).toBeNull();
  });
});

describe("buildResendTicketReply", () => {
  it("asks the customer to double-check details when no booking was found — never fabricates a match", () => {
    const reply = buildResendTicketReply({ found: false });
    expect(reply).toMatch(/couldn't find/i);
  });

  it("confirms the channels it actually sent through when found and delivered", () => {
    const reply = buildResendTicketReply({ found: true, pnr: "ABC123", emailStatus: "SENT", whatsappStatus: "SENT" });
    expect(reply).toMatch(/ABC123/);
    expect(reply).toMatch(/email and WhatsApp/);
  });

  it("mentions only the channel that actually succeeded", () => {
    const reply = buildResendTicketReply({ found: true, pnr: "ABC123", emailStatus: "SENT", whatsappStatus: "FAILED" });
    expect(reply).toMatch(/via email\./);
    expect(reply).not.toMatch(/WhatsApp/);
  });

  it("never claims a resend succeeded when every channel failed/skipped", () => {
    const reply = buildResendTicketReply({ found: true, pnr: "ABC123", emailStatus: "FAILED", whatsappStatus: "SKIPPED" });
    expect(reply).not.toMatch(/resent/i);
    expect(reply).toMatch(/wasn't able to resend/i);
  });
});

describe("original escalation and confirmation detection continued", () => {
  it("detects itinerary-presented, escalated, and booking-confirmed markers in a transcript", () => {
    const messages = [
      { role: "assistant" as const, content: "Reply 'confirm' to proceed with this plan." }
    ];
    expect(wasItineraryPresented(messages)).toBe(true);
    expect(
      wasEscalated([{ role: "assistant" as const, content: "I'll connect you with a human team member." }])
    ).toBe(true);
    expect(
      wasBookingConfirmed([
        { role: "assistant" as const, content: "Your booking intent has been recorded (reference LEAD-1)." }
      ])
    ).toBe(true);
  });
});

describe("deriveTravelState", () => {
  it("reports COLLECT_NAME as the resting stage for a brand-new conversation, before onboarding is done", () => {
    const state = deriveTravelState([{ role: "user", content: "hi" }]);
    expect(state.stage).toBe("COLLECT_NAME");
    expect(state.customerName).toBeNull();
    expect(state.onboardingCompleted).toBe(false);
    expect(state.greetingSent).toBe(true);
  });
  it("reports COLLECT_DESTINATION once the traveler's name is known", () => {
    const state = deriveTravelState([
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: "Nice to meet you, Alex. Where would you like to travel?" },
      { role: "user", content: "hi" }
    ]);
    expect(state.stage).toBe("COLLECT_DESTINATION");
    expect(state.customerName).toBe("Alex");
    expect(state.onboardingCompleted).toBe(true);
    expect(state.missingFields).toContain("destination");
  });
  it("reports DISCOVER_INTENT while the Intent Discovery menu is the most recent (unanswered) message", () => {
    const state = deriveTravelState([
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: "Good morning, Alex! 👋 What can I help you with?" }
    ]);
    expect(state.stage).toBe("DISCOVER_INTENT");
    expect(state.customerName).toBe("Alex");
  });
  it("moves past DISCOVER_INTENT once the traveler replies to it", () => {
    const state = deriveTravelState([
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: "Good morning, Alex! 👋 What can I help you with?" },
      { role: "user", content: "I'd like to plan a trip" }
    ]);
    expect(state.stage).not.toBe("DISCOVER_INTENT");
  });
  it("progresses to CONFIRM_BOOKING once every slot is filled and the itinerary was presented", () => {
    const state = deriveTravelState([
      { role: "user", content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $2000" },
      { role: "assistant", content: "Here is your plan.\n\nReply 'confirm' to proceed with this plan." }
    ]);
    expect(state.stage).toBe("CONFIRM_BOOKING");
    expect(state.missingFields).toEqual([]);
    expect(state.destination).toBe("Dubai");
  });
  it("reports BOOKING_CONFIRMED and ESCALATED as terminal stages", () => {
    expect(
      deriveTravelState([
        { role: "user", content: "confirm" },
        { role: "assistant", content: "Your booking intent has been recorded (reference LEAD-1)." }
      ]).stage
    ).toBe("BOOKING_CONFIRMED");
    expect(
      deriveTravelState([
        { role: "user", content: "talk to a human" },
        { role: "assistant", content: "I'll connect you with a human team member." }
      ]).stage
    ).toBe("ESCALATED");
  });
  it("resumes a partially-filled conversation without losing already-collected slots", () => {
    const priorTranscript = [
      { role: "user" as const, content: "My name is Alex" },
      { role: "assistant" as const, content: "Nice to meet you, Alex. Where would you like to travel?" },
      { role: "user" as const, content: "Dubai please" },
      { role: "assistant" as const, content: "When are you planning to travel?" }
    ];
    const resumed = deriveTravelState([...priorTranscript, { role: "user", content: "December, 5 days" }]);
    expect(resumed.destination).toBe("Dubai");
    expect(resumed.travelMonth).toBe("December");
    expect(resumed.stage).toBe("COLLECT_PASSENGERS");
  });
});

describe("placeholder search generators", () => {
  it("produces deterministic, clearly-labeled placeholder flight and hotel options", () => {
    const flightsA = generatePlaceholderFlights({ destination: "Dubai", passengers: 2 });
    const flightsB = generatePlaceholderFlights({ destination: "Dubai", passengers: 2 });
    expect(flightsA).toEqual(flightsB);
    expect(flightsA.flightOptions).toHaveLength(2);
    expect(flightsA.disclaimer).toMatch(/placeholder/i);
    const hotels = generatePlaceholderHotels({ destination: "Dubai" });
    expect(hotels.hotelOptions).toHaveLength(2);
    expect(hotels.disclaimer).toMatch(/placeholder/i);
  });
});

describe("buildCrmLeadPayload", () => {
  it("produces a structured lead payload suitable for CRM integration", () => {
    const payload = buildCrmLeadPayload(
      {
        destination: "Dubai",
        travelMonth: "December",
        durationDays: 5,
        passengers: 2,
        budgetAmount: 2000,
        budgetCurrency: "USD"
      },
      "Dubai trip, 2 adults"
    );
    expect(payload.source).toBe("TRAVEL_EMPLOYEE_AI");
    expect(payload.interest).toBe("Dubai trip");
    expect(payload.metadata).toMatchObject({ destination: "Dubai", passengers: 2, budgetAmount: 2000 });
  });
});

describe("TravelEmployeeProvider", () => {
  const config: TravelEmployeeRuntimeConfig = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;
  const searchTools = [
    { name: "travel.search_flights", description: "", inputSchema: {} },
    { name: "travel.search_hotels", description: "", inputSchema: {} },
    { name: "travel.escalate", description: "", inputSchema: {} }
  ];

  it("asks for the traveler's name before anything else on the first turn (onboarding gate)", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: searchTools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/may i know your name/i);
    expect(result.content).not.toMatch(/where would you like to travel/i);
  });

  it("offers the Intent Discovery menu once the traveler's name is known, instead of assuming a trip is being planned", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: config.welcomeMessage },
        { role: "user", content: "My name is Alex" }
      ],
      tools: searchTools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/alex/i);
    expect(result.content).toMatch(/what can i help you with/i);
    expect(result.content).toMatch(/plan a trip/i);
    expect(result.content).toMatch(/build an itinerary/i);
    expect(result.content).toMatch(/estimate costs/i);
    expect(result.content).toMatch(/explain policies/i);
    expect(result.content).toMatch(/answer travel questions/i);
    expect(result.content).not.toMatch(/where would you like to travel/i);
  });

  it("greets and asks for the destination once the traveler states trip intent after the Intent Discovery menu", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: config.welcomeMessage },
        { role: "user", content: "My name is Alex" },
        { role: "assistant", content: "How may I help you today?" },
        { role: "user", content: "I'd like to plan a trip" }
      ],
      tools: searchTools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/where would you like to travel/i);
  });

  it("never re-asks for a slot already collected, and asks the remaining missing ones together", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: config.welcomeMessage },
        { role: "user", content: "My name is Alex" },
        { role: "assistant", content: "Nice to meet you, Alex. Where would you like to travel to?" },
        { role: "user", content: "Dubai" }
      ],
      tools: searchTools
    });
    expect(result.content).not.toMatch(/where would you like to travel/i);
    // Multiple fields are still missing (dates, travelers, budget) — asked together in one natural,
    // bulleted message rather than one mechanical question per turn (see "Clarification strategy").
    expect(result.content).toMatch(/when you're travelling/i);
    expect(result.content).toMatch(/how many people/i);
    expect(result.content).toMatch(/approximate budget/i);
  });

  it("asks for all remaining missing fields together when stuck on an unparseable reply", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "My name is Alex" },
        { role: "assistant", content: "Nice to meet you, Alex. Where would you like to travel?" },
        { role: "user", content: "Dubai" },
        { role: "assistant", content: "When are you planning to travel?" },
        { role: "user", content: "not sure yet, whenever works" }
      ],
      tools: searchTools
    });
    expect(result.content).toMatch(/i'd like to know/i);
    expect(result.content).toMatch(/when you're travelling/i);
  });

  it("emits a search_flights tool call once every slot is filled", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" }
      ],
      tools: searchTools
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
  });

  it("chains search_flights -> search_hotels -> a recommendation with an itinerary summary", async () => {
    const provider = new TravelEmployeeProvider(config);
    const userMessage = {
      role: "user" as const,
      content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000"
    };
    const flightsCall = await provider.complete({ messages: [userMessage], tools: searchTools });
    const flightsResult = JSON.stringify({ flightOptions: [{ airline: "Test Air", price: 400, currency: "USD", stops: 0, durationHours: 5 }] });
    const flightsCallId = requireId(flightsCall.toolCalls[0]);
    const hotelsCall = await provider.complete({
      messages: [
        userMessage,
        { role: "assistant", content: "", toolCallId: flightsCallId },
        { role: "tool", content: flightsResult, toolCallId: flightsCallId }
      ],
      tools: searchTools
    });
    expect(hotelsCall.toolCalls[0]?.name).toBe("travel.search_hotels");
    const hotelsCallId = requireId(hotelsCall.toolCalls[0]);
    const hotelsResult = JSON.stringify({ hotelOptions: [{ name: "Test Hotel", pricePerNight: 100, currency: "USD", rating: 4.2 }] });
    const recommendation = await provider.complete({
      messages: [
        userMessage,
        { role: "assistant", content: "", toolCallId: flightsCallId },
        { role: "tool", content: flightsResult, toolCallId: flightsCallId },
        { role: "assistant", content: "", toolCallId: hotelsCallId },
        { role: "tool", content: hotelsResult, toolCallId: hotelsCallId }
      ],
      tools: searchTools
    });
    expect(recommendation.toolCalls).toEqual([]);
    expect(recommendation.content).toMatch(/itinerary summary/i);
    expect(recommendation.content).toMatch(/test air/i);
    expect(recommendation.content).toMatch(/test hotel/i);
    expect(recommendation.content).toMatch(/reply 'confirm' to proceed/i);
    expect(recommendation.content).toMatch(/no booking has been made/i);
  });

  // Renamed and rewritten: internal TravelLead persistence must never depend on whether an external CRM
  // connector happens to be available (see travel-lead.service.ts). A booking confirmation with no phone
  // number yet asks for one — it never fires a tool call (CRM or otherwise) before contact details exist —
  // and once given, always persists via the SAME `travel.create_lead` tool the LLM orchestrator uses,
  // whether or not a CRM tool is also available.
  it("CRM available: asks for a phone number on confirmation, then persists internally via travel.create_lead (never calls the CRM tool directly)", async () => {
    const provider = new TravelEmployeeProvider(config);
    const tools = [...searchTools, { name: "connector.dummy-crm.crm.create_lead", description: "", inputSchema: {} }];
    const confirmResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "yes, confirm" }
      ],
      tools
    });
    expect(confirmResult.toolCalls).toEqual([]);
    expect(confirmResult.content).toMatch(/phone number|mobile number/i);

    const phoneResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "yes, confirm" },
        { role: "assistant" as const, content: confirmResult.content },
        { role: "user" as const, content: "+919876543210" }
      ],
      tools
    });
    expect(phoneResult.toolCalls).toHaveLength(1);
    expect(phoneResult.toolCalls[0]?.name).toBe("travel.create_lead");
    const args = phoneResult.toolCalls[0]?.arguments as { phoneNumber: string };
    expect(args.phoneNumber).toBe("+919876543210");
  });

  it("CRM unavailable: still asks for a phone number, then persists an internal TravelLead and returns a successful reference — CRM availability never gates this", async () => {
    const provider = new TravelEmployeeProvider(config);
    const confirmResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "confirm" }
      ],
      tools: searchTools
    });
    expect(confirmResult.toolCalls).toEqual([]);
    expect(confirmResult.content).toMatch(/phone number|mobile number/i);
    expect(confirmResult.content).not.toMatch(/CRM/i);

    const phoneResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "confirm" },
        { role: "assistant" as const, content: confirmResult.content },
        { role: "user" as const, content: "+919876543210" }
      ],
      tools: searchTools
    });
    expect(phoneResult.toolCalls[0]?.name).toBe("travel.create_lead");

    // The tool's own response resolving within the same execution — the customer sees a plain success
    // message, never a "CRM unavailable" error.
    const captured = await provider.complete({
      messages: [
        { role: "user" as const, content: "confirm" },
        { role: "assistant" as const, content: "", toolCallId: "1" },
        { role: "tool" as const, content: JSON.stringify({ leadId: "lead-1", reference: "TRV-ABC123" }), toolCallId: "1" }
      ],
      tools: searchTools
    });
    expect(captured.content).toMatch(/travel request has been submitted successfully/i);
    expect(captured.content).toContain("TRV-ABC123");
    expect(captured.content).not.toMatch(/CRM|connector/i);
  });

  it("required test #1: 'call me' (request callback) with no CRM tool asks for a phone number, then persists a TravelLead once given — no CRM-required error", async () => {
    const provider = new TravelEmployeeProvider(config);
    const askResult = await provider.complete({
      messages: [{ role: "user" as const, content: "My name is Alex. Please call me about a Dubai trip." }],
      tools: searchTools
    });
    expect(askResult.toolCalls).toEqual([]);
    expect(askResult.content).toMatch(/phone number|mobile number/i);
    expect(askResult.content).not.toMatch(/CRM/i);

    const phoneResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Please call me about a Dubai trip." },
        { role: "assistant" as const, content: askResult.content },
        { role: "user" as const, content: "+919876543210" }
      ],
      tools: searchTools
    });
    expect(phoneResult.toolCalls[0]?.name).toBe("travel.create_lead");
  });

  it("required test #2: 'submit this request' (submit enquiry) with no CRM tool available still succeeds internally once a phone number is given", async () => {
    const provider = new TravelEmployeeProvider(config);
    const askResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Priya." },
        { role: "user" as const, content: "Submit this request for a Goa trip" }
      ],
      tools: []
    });
    expect(askResult.toolCalls).toEqual([]);
    expect(askResult.content).toMatch(/phone number|mobile number/i);

    const phoneResult = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Priya." },
        { role: "user" as const, content: "Submit this request for a Goa trip" },
        { role: "assistant" as const, content: askResult.content },
        { role: "user" as const, content: "9876543210" }
      ],
      tools: []
    });
    expect(phoneResult.toolCalls[0]?.name).toBe("travel.create_lead");
    const args = phoneResult.toolCalls[0]?.arguments as { phoneNumber: string };
    expect(args.phoneNumber).toBe("9876543210");
  });

  it("required test #3: below-minimum budget reaches contact capture (and would save internally) without ever depending on a CRM tool", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $200" }
      ],
      tools: []
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/minimum budget/i);
    expect(result.content).toMatch(/phone number|mobile number/i);
    expect(result.content).not.toMatch(/CRM/i);
  });

  it("required test #12/#13: never creates a lead before BOTH consent (an explicit ask) and a phone number exist", async () => {
    const provider = new TravelEmployeeProvider(config);
    // Itinerary presented, but the reply is neither a confirmation nor a phone number — no consent yet.
    const noConsent = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "what's the weather like there?" }
      ],
      tools: []
    });
    expect(noConsent.toolCalls).toEqual([]);
    expect(noConsent.content).not.toMatch(/phone number|mobile number/i);

    // Consent given, but no phone number yet — must ask, never create a lead without one.
    const consentNoPhone = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" },
        { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
        { role: "user" as const, content: "yes, confirm" }
      ],
      tools: []
    });
    expect(consentNoPhone.toolCalls).toEqual([]);
    expect(consentNoPhone.content).toMatch(/phone number|mobile number/i);
  });

  it("required test #15: a bare 'ji' mid-collection (destination known, dates/travelers/budget still missing) never asks for a phone number or creates a lead", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user" as const, content: "My name is Alex. Dubai please." },
        { role: "assistant" as const, content: "Nice to meet you, Alex. When are you travelling, how many people, and what's your budget?" },
        { role: "user" as const, content: "ji" }
      ],
      tools: searchTools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).not.toMatch(/phone number|mobile number/i);
    expect(result.content).not.toMatch(/travel request has been submitted/i);
  });

  it("escalates via the travel.escalate tool and reports the escalation contact afterwards", async () => {
    const provider = new TravelEmployeeProvider({ ...config, escalationContact: "help@example.com" });
    const escalateCall = await provider.complete({
      messages: [{ role: "user", content: "I want to talk to a human agent" }],
      tools: searchTools
    });
    expect(escalateCall.toolCalls[0]?.name).toBe("travel.escalate");
    const escalateCallId = requireId(escalateCall.toolCalls[0]);
    const escalateResult = JSON.stringify({ escalated: true, contact: "help@example.com" });
    const finalResult = await provider.complete({
      messages: [
        { role: "user", content: "I want to talk to a human agent" },
        { role: "assistant", content: "", toolCallId: escalateCallId },
        { role: "tool", content: escalateResult, toolCallId: escalateCallId }
      ],
      tools: searchTools
    });
    expect(finalResult.content).toContain("help@example.com");
  });

  it("falls back to a synthesized recommendation when search tools are not granted", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $6000" }
      ],
      tools: []
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/itinerary summary/i);
  });
});

describe("Stage 9E: TravelEmployeeProvider TravelRuntimeExecutionMode for the BELOW_MINIMUM budget trigger", () => {
  const config: TravelEmployeeRuntimeConfig = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;
  const belowMinimumMessage = {
    role: "user" as const,
    content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $100"
  };

  it("STANDALONE_COMPATIBILITY (the default, unaffected by Stage 9E) transitions completionStage/pendingInputAction directly and never emits a workflow signal", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({ messages: [belowMinimumMessage] });
    expect(result.content).toMatch(/minimum budget/i);
    expect(provider.lastMemory.completionStage).toBe("AWAITING_CONTACT");
    expect(provider.lastMemory.pendingInputAction).toBe("AWAITING_LEAD_CONTACT");
    expect(provider.lastWorkflowSignal).toBeNull();
  });

  it("PLATFORM_MANAGED additionally emits a typed START_TRIP_SUBMISSION signal, with the identical message and legacy memory transition", async () => {
    const standalone = new TravelEmployeeProvider(config);
    const standaloneResult = await standalone.complete({ messages: [belowMinimumMessage] });

    const platformManaged = new TravelEmployeeProvider(
      config,
      undefined,
      undefined,
      "PLATFORM_MANAGED"
    );
    const platformManagedResult = await platformManaged.complete({ messages: [belowMinimumMessage] });

    expect(platformManagedResult.content).toBe(standaloneResult.content);
    expect(platformManaged.lastMemory.completionStage).toBe(standalone.lastMemory.completionStage);
    expect(platformManaged.lastMemory.pendingInputAction).toBe(standalone.lastMemory.pendingInputAction);
    expect(platformManaged.lastWorkflowSignal).toEqual({
      signalType: "START_TRIP_SUBMISSION",
      trigger: "BELOW_MINIMUM_BUDGET"
    });
  });

  it("lastWorkflowSignal is reset every turn — a later turn that no longer hits BELOW_MINIMUM (contact already provided) reports no signal", async () => {
    const provider = new TravelEmployeeProvider(config, undefined, undefined, "PLATFORM_MANAGED");
    const first = await provider.complete({ messages: [belowMinimumMessage] });
    expect(provider.lastWorkflowSignal).not.toBeNull();

    const phoneReply = await provider.complete({
      messages: [
        belowMinimumMessage,
        { role: "assistant", content: first.content },
        { role: "user", content: "+919876543210" }
      ]
    });
    expect(phoneReply.toolCalls[0]?.name).toBe("travel.create_lead");
    expect(provider.lastWorkflowSignal).toBeNull();
  });
});

describe("extractCustomerName", () => {
  it("captures an explicit self-introduction anywhere in the transcript", () => {
    expect(extractCustomerName(["My name is Krishna"])).toBe("Krishna");
    expect(extractCustomerName(["I'm Priya"])).toBe("Priya");
    expect(extractCustomerName(["call me Sam"])).toBe("Sam");
    expect(extractCustomerName(["hi", "this is Meera"])).toBe("Meera");
  });
  it("stops the captured name at the first word that continues the sentence, not the whole phrase", () => {
    expect(extractCustomerName(["My name is Krishna and I want to visit Delhi"])).toBe("Krishna");
    expect(extractCustomerName(["My name is Priya, I am planning a trip to Goa"])).toBe("Priya");
  });
  it("captures a bare short reply as the name (the direct answer to 'may I know your name?')", () => {
    expect(extractCustomerName(["Krishna"])).toBe("Krishna");
    expect(extractCustomerName(["Krishna Kumar"])).toBe("Krishna Kumar");
  });
  it("never reads trip content, stopwords, or a known destination city as a name", () => {
    expect(extractCustomerName(["Delhi jana hai"])).toBeNull();
    expect(extractCustomerName(["Dubai"])).toBeNull();
    expect(extractCustomerName(["confirm"])).toBeNull();
    expect(extractCustomerName(["yes"])).toBeNull();
    expect(extractCustomerName(["August"])).toBeNull();
    expect(extractCustomerName(["I'm planning a trip"])).toBeNull();
  });
  it("returns null (never guesses) when no name signal is present anywhere", () => {
    expect(extractCustomerName(["Dubai in December for 5 days, 2 adults, budget $2000"])).toBeNull();
  });
});

describe("TravelEmployeeProvider: onboarding (COLLECT_NAME gate)", () => {
  const config: TravelEmployeeRuntimeConfig = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

  it("acknowledges trip content mentioned before the name is known, but still asks for the name (never skips onboarding)", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Delhi jana hai" }],
      tools: []
    });
    expect(result.content).toMatch(/delhi/i);
    expect(result.content).toMatch(/may i know your name/i);
    expect(result.content).not.toMatch(/when you're travelling|how many people/i);
  });

  it("captures both the name and the destination when given together in one message, and never re-asks either", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "My name is Krishna and I want to visit Delhi" }],
      tools: []
    });
    expect(result.content).toMatch(/nice to meet you, krishna\./i);
    expect(result.content).not.toMatch(/where would you like to travel/i);
    expect(result.content).toMatch(/when you're travelling/i);
  });

  it("offers the Intent Discovery menu once the name is captured with no trip content stated, instead of assuming a trip is being planned", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Krishna" }],
      tools: []
    });
    expect(result.content).toMatch(/krishna/i);
    expect(result.content).toMatch(/what can i help you with/i);
    expect(result.content).not.toMatch(/where would you like to travel/i);
  });
});

describe("timeOfDayGreeting", () => {
  it("returns Good morning before noon", () => {
    expect(timeOfDayGreeting(new Date("2026-01-01T08:00:00"))).toBe("Good morning");
    expect(timeOfDayGreeting(new Date("2026-01-01T11:59:00"))).toBe("Good morning");
  });
  it("returns Good afternoon from noon up to 5pm", () => {
    expect(timeOfDayGreeting(new Date("2026-01-01T12:00:00"))).toBe("Good afternoon");
    expect(timeOfDayGreeting(new Date("2026-01-01T16:59:00"))).toBe("Good afternoon");
  });
  it("returns Good evening from 5pm onward", () => {
    expect(timeOfDayGreeting(new Date("2026-01-01T17:00:00"))).toBe("Good evening");
    expect(timeOfDayGreeting(new Date("2026-01-01T23:00:00"))).toBe("Good evening");
  });
});

describe("buildIntentDiscoveryMessage", () => {
  const morning = new Date("2026-01-01T08:00:00");

  it("greets by name with a time-of-day greeting and lists every menu item, in English by default", () => {
    const message = buildIntentDiscoveryMessage("Krishna", "ENGLISH", morning);
    expect(message).toMatch(/^good morning, krishna! 👋 what can i help you with\?/i);
    expect(message).toMatch(/plan a trip/i);
    expect(message).toMatch(/build an itinerary/i);
    expect(message).toMatch(/estimate costs/i);
    expect(message).toMatch(/explain policies/i);
    expect(message).toMatch(/answer travel questions/i);
    expect(message).toMatch(/leisure or business/i);
    // Never document/debug-style scaffolding — this is a customer-facing greeting.
    expect(message).not.toMatch(/confidence|chunk|according to the uploaded/i);
  });

  it("varies the greeting word by time of day", () => {
    expect(buildIntentDiscoveryMessage("Krishna", "ENGLISH", new Date("2026-01-01T08:00:00"))).toMatch(
      /^good morning/i
    );
    expect(buildIntentDiscoveryMessage("Krishna", "ENGLISH", new Date("2026-01-01T14:00:00"))).toMatch(
      /^good afternoon/i
    );
    expect(buildIntentDiscoveryMessage("Krishna", "ENGLISH", new Date("2026-01-01T20:00:00"))).toMatch(
      /^good evening/i
    );
  });

  it("renders in Hinglish and Hindi when the traveler's language is detected as such", () => {
    const hinglish = buildIntentDiscoveryMessage("Krishna", "HINGLISH", morning);
    expect(hinglish).toMatch(/krishna/i);
    expect(hinglish).toMatch(/kis cheez mein madad/i);

    const hindi = buildIntentDiscoveryMessage("Krishna", "HINDI", morning);
    expect(hindi).toMatch(/krishna/i);
    expect(hindi).toMatch(/किस चीज़ में मदद/);
  });
});

describe("isIntentDiscoveryPending", () => {
  it("is true only when the Intent Discovery menu is the very last message, not once the traveler has replied", () => {
    const menu = buildIntentDiscoveryMessage("Krishna", "ENGLISH");
    expect(isIntentDiscoveryPending([{ role: "assistant", content: menu }])).toBe(true);
    expect(
      isIntentDiscoveryPending([
        { role: "assistant", content: menu },
        { role: "user", content: "I want to plan a trip" }
      ])
    ).toBe(false);
  });
  it("is false when the menu was never shown", () => {
    expect(isIntentDiscoveryPending([{ role: "user", content: "hi" }])).toBe(false);
    expect(isIntentDiscoveryPending([])).toBe(false);
  });
});

describe("reconcileRouteFromMessage (deterministic origin/destination correction)", () => {
  it("treats a bare destination statement as the destination, never the origin, even when the model proposed origin", () => {
    const extracted = reconcileRouteFromMessage("mujhe london jana hai", {}, null);
    expect(extracted.destinationCity).toBe("London");
    expect(extracted.originCity ?? null).toBeNull();
  });

  it("replaces a stale, already-confirmed destination with a new bare destination statement, and clears a same-city origin misextraction", () => {
    // Reproduces the reported bug: after "mujhe london jana hai" set destinationCity=London, a later
    // "mujhe mumbai jana hai" must replace it with Mumbai, not be misread as supplying Mumbai as the
    // origin for the already-known London destination.
    const buggyExtraction = { originCity: "Mumbai", destinationCity: null };
    const extracted = reconcileRouteFromMessage("mujhe mumbai jana hai", buggyExtraction, null);
    expect(extracted.destinationCity).toBe("Mumbai");
    expect(extracted.originCity).toBeNull();
  });

  it("parses an explicit connector-based route: origin and destination both set from 'X se Y jana hai'", () => {
    const extracted = reconcileRouteFromMessage("Mumbai se London jana hai", {}, null);
    expect(extracted.originCity).toBe("Mumbai");
    expect(extracted.destinationCity).toBe("London");
  });

  it("parses 'delhi se mumbai jana hai' as origin=Delhi, destination=Mumbai", () => {
    const extracted = reconcileRouteFromMessage("delhi se mumbai jana hai", {}, null);
    expect(extracted.originCity).toBe("Delhi");
    expect(extracted.destinationCity).toBe("Mumbai");
  });

  it("parses the English connector 'to' the same way: 'delhi to mumbai'", () => {
    const extracted = reconcileRouteFromMessage("i want to travel delhi to mumbai on 10 dec 26", {}, null);
    expect(extracted.originCity).toBe("Delhi");
    expect(extracted.destinationCity).toBe("Mumbai");
  });

  it("does not read a correction statement ('not London, Paris') as a route", () => {
    // Two known cities with no connector between them — a correction, not a journey.
    const extracted = reconcileRouteFromMessage("not London, Paris", { destinationCity: "Paris" }, null);
    expect(extracted.originCity ?? null).toBeNull();
    expect(extracted.destinationCity).toBe("Paris");
  });

  it("leaves a bare one-word reply to 'which city are you departing from?' untouched, deferring to context", () => {
    const extracted = reconcileRouteFromMessage("Delhi", { originCity: "Delhi" }, "originCity");
    expect(extracted.originCity).toBe("Delhi");
    expect(extracted.destinationCity ?? null).toBeNull();
  });

  it("leaves a bare one-word reply untouched even without lastAskedField context (no destination-verb phrase present)", () => {
    const extracted = reconcileRouteFromMessage("New Delhi", { originCity: "New Delhi" }, null);
    expect(extracted.originCity).toBe("New Delhi");
  });

  it("full merge: 'mujhe london jana hai' then 'mujhe mumbai jana hai' — destination changes to Mumbai and London is removed, through the real confirmed-entity merge", () => {
    const firstTurnExtraction = reconcileRouteFromMessage("mujhe london jana hai", {}, null);
    const firstMerge = mergeConfirmedEntities(
      EMPTY_TRAVEL_ENTITIES,
      EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      firstTurnExtraction,
      "provide_trip_details"
    );
    expect(firstMerge.values.destinationCity).toBe("London");
    expect(firstMerge.values.originCity).toBeNull();

    // Simulate the LLM extraction bug directly: it proposes Mumbai as the origin for the second turn.
    const secondTurnExtraction = reconcileRouteFromMessage(
      "mujhe mumbai jana hai",
      { originCity: "Mumbai" },
      null
    );
    const secondMerge = mergeConfirmedEntities(
      firstMerge.values,
      firstMerge.confirmation,
      secondTurnExtraction,
      "provide_trip_details"
    );
    expect(secondMerge.values.destinationCity).toBe("Mumbai");
    expect(secondMerge.values.originCity).toBeNull();
    expect(secondMerge.destinationChanged).toEqual({ from: "London", to: "Mumbai" });
  });

  it("latest explicit destination overrides a previously confirmed one ('Mumbai se London jana hai' after a prior destination)", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Dubai" };
    const priorConfirmation = { destinationCity: { source: "user" as const, confidence: 1, confirmed: true, updatedAt: new Date().toISOString() } };
    const extracted = reconcileRouteFromMessage("Mumbai se London jana hai", {}, null);
    const merged = mergeConfirmedEntities(prior, priorConfirmation, extracted, "provide_trip_details");
    expect(merged.values.originCity).toBe("Mumbai");
    expect(merged.values.destinationCity).toBe("London");
  });

  it("never invents a date: a route correction with no date restated leaves the confirmed departure date exactly as it was, never fabricated or altered", () => {
    // Reproduces the reported bug's shape: Delhi -> Mumbai with a confirmed date, then later the route
    // changes to London -> Mumbai with no date mentioned at all — the date must be carried forward
    // unchanged (from history, per "history fills only missing slots"), never invented or silently
    // rewritten to a different value.
    const priorWithDate = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Mumbai", departureDate: "2026-12-10", travelMonth: "December" };
    const priorConfirmation = {
      originCity: { source: "user" as const, confidence: 1, confirmed: true, updatedAt: new Date().toISOString() },
      destinationCity: { source: "user" as const, confidence: 1, confirmed: true, updatedAt: new Date().toISOString() },
      departureDate: { source: "user" as const, confidence: 1, confirmed: true, updatedAt: new Date().toISOString() }
    };
    // Simulate a route-only correction: extraction (LLM or fallback) reports nothing for the date fields.
    const extracted = reconcileRouteFromMessage("London se Mumbai jana hai", {}, null);
    expect(extracted.departureDate ?? null).toBeNull();
    expect(extracted.travelMonth ?? null).toBeNull();
    const merged = mergeConfirmedEntities(priorWithDate, priorConfirmation, extracted, "provide_trip_details");
    expect(merged.values.originCity).toBe("London");
    expect(merged.values.destinationCity).toBe("Mumbai");
    // The date is exactly what it was before — carried forward, not invented, not silently changed.
    expect(merged.values.departureDate).toBe("2026-12-10");
    expect(merged.values.travelMonth).toBe("December");
  });

  it("the extraction system prompt explicitly forbids inventing a year or date the user did not state", () => {
    expect(TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT).toMatch(/never invent or guess/i);
    expect(TRAVEL_ENTITY_EXTRACTION_SYSTEM_PROMPT).toMatch(/year/i);
  });
});

describe("Sprint 6.5 — deterministic origin capture", () => {
  it('extracts an explicit "from <City>" phrase', () => {
    expect(extractOriginCity("from Delhi")).toBe("Delhi");
    expect(extractOriginCity("flying from Mumbai please")).toBe("Mumbai");
  });

  it('stops at "to" so a connected route phrase yields only the origin half', () => {
    expect(extractOriginCity("from Delhi to Dubai")).toBe("Delhi");
  });

  it("returns null when there's no explicit origin phrase", () => {
    expect(extractOriginCity("Dubai please")).toBeNull();
  });

  it("resolveOriginReplyDeterministically falls back to a bare known-city reply, since the pending question itself disambiguates it as origin", () => {
    expect(resolveOriginReplyDeterministically("Delhi")).toBe("Delhi");
    expect(resolveOriginReplyDeterministically("from Delhi")).toBe("Delhi");
  });
});

describe("Sprint 6.5 — generalized deterministic correction detection", () => {
  it("detects a differing budget as a correction (Stage 9F's original case, preserved)", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, budget: 5000 };
    expect(detectExplicitFieldCorrection({ budget: 10000 }, prior)).toBe(true);
  });

  it("detects a differing passenger count as a correction — the no-LLM gap this sprint closes", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, adults: 2 };
    expect(detectExplicitFieldCorrection({ adults: 3 }, prior)).toBe(true);
  });

  it("detects a differing travel month as a correction ('September' -> 'October')", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, travelMonth: "September" };
    expect(detectExplicitFieldCorrection({ travelMonth: "October" }, prior)).toBe(true);
  });

  it("detects a differing nights count as a correction ('Make that 7 nights')", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, nights: 3 };
    expect(detectExplicitFieldCorrection({ nights: 7 }, prior)).toBe(true);
  });

  it("is false when the deterministic value matches the prior value (nothing changed)", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, budget: 5000 };
    expect(detectExplicitFieldCorrection({ budget: 5000 }, prior)).toBe(false);
  });

  it("is false when the field is being set for the FIRST time (prior null) — new information, not a correction", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, budget: null };
    expect(detectExplicitFieldCorrection({ budget: 5000 }, prior)).toBe(false);
  });

  it("is false when the deterministic extractor found nothing for any correctable field", () => {
    const prior = { ...EMPTY_TRAVEL_ENTITIES, budget: 5000, adults: 2 };
    expect(detectExplicitFieldCorrection({}, prior)).toBe(false);
  });
});

describe("Sprint 6.5 — material-correction invalidation of stale package options", () => {
  it("flags a genuine change from a known prior value on a material field", () => {
    expect(hasMaterialPackageChange(["adults=5 (was 2)"])).toBe(true);
    expect(hasMaterialPackageChange(["destinationCity=Singapore (was Dubai)"])).toBe(true);
    expect(hasMaterialPackageChange(["budget=15000 (was 10000)"])).toBe(true);
  });

  it("does not flag a field being set for the first time (no prior value)", () => {
    expect(hasMaterialPackageChange(["adults=2"])).toBe(false);
  });

  it("does not flag a non-material field changing (cabin class refines, doesn't invalidate)", () => {
    expect(hasMaterialPackageChange(["cabinClass=BUSINESS (was ECONOMY)"])).toBe(false);
  });

  it("is false for an empty changed list", () => {
    expect(hasMaterialPackageChange([])).toBe(false);
  });
});

describe("Sprint 6.5 — out-of-order and multi-slot deterministic extraction (no LLM required)", () => {
  it("extracts destination and a broad date window from one unprompted message", () => {
    const result = deterministicExtractFallback("I need Dubai next month");
    expect(result.destinationCity).toBe("Dubai");
    expect(result.travelMonth).not.toBeNull();
  });

  it("a single message stating destination, passengers, nights, and budget together populates all four fields deterministically", () => {
    const result = deterministicExtractFallback("Dubai next month, 2 adults, 5 nights, budget 10000 AED");
    expect(result.destinationCity).toBe("Dubai");
    expect(result.adults).toBe(2);
    expect(result.nights).toBe(5);
    expect(result.budget).toBe(10000);
    expect(result.budgetCurrency).toBe("AED");
  });

  it("slot order does not matter: budget-first then destination-first extraction agree on the final values", () => {
    const budgetFirst = deterministicExtractFallback("budget 10000 AED, 2 adults, 5 nights, Dubai");
    const destinationFirst = deterministicExtractFallback("Dubai, 2 adults, 5 nights, budget 10000 AED");
    expect(budgetFirst.destinationCity).toBe(destinationFirst.destinationCity);
    expect(budgetFirst.adults).toBe(destinationFirst.adults);
    expect(budgetFirst.nights).toBe(destinationFirst.nights);
    expect(budgetFirst.budget).toBe(destinationFirst.budget);
  });

  it("accumulates fields across separate out-of-order turns via mergeConfirmedEntities, never losing an earlier turn's information", () => {
    const turn1 = deterministicExtractFallback("Dubai next month");
    const afterTurn1 = mergeConfirmedEntities(
      EMPTY_TRAVEL_ENTITIES,
      EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      turn1,
      "provide_trip_details"
    );
    expect(afterTurn1.values.destinationCity).toBe("Dubai");

    const turn2 = deterministicExtractFallback("2 adults");
    const afterTurn2 = mergeConfirmedEntities(
      afterTurn1.values,
      afterTurn1.confirmation,
      turn2,
      "provide_trip_details"
    );
    expect(afterTurn2.values.destinationCity).toBe("Dubai"); // never lost
    expect(afterTurn2.values.adults).toBe(2);

    const turn3Extraction = { ...deterministicExtractFallback("5 nights"), originCity: resolveOriginReplyDeterministically("from Delhi") };
    const afterTurn3 = mergeConfirmedEntities(
      afterTurn2.values,
      afterTurn2.confirmation,
      turn3Extraction,
      "provide_trip_details"
    );
    expect(afterTurn3.values.destinationCity).toBe("Dubai");
    expect(afterTurn3.values.adults).toBe(2);
    expect(afterTurn3.values.nights).toBe(5);
    expect(afterTurn3.values.originCity).toBe("Delhi");
  });
});
