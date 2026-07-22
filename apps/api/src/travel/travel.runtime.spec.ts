import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  TravelEmployeeProvider,
  buildCrmLeadPayload,
  deriveTravelState,
  extractBudget,
  extractDestination,
  extractDurationDays,
  extractPassengers,
  extractTravelMonth,
  extractTravelSlots,
  generatePlaceholderFlights,
  generatePlaceholderHotels,
  isBookingConfirmation,
  isEscalationRequest,
  missingFields,
  wasBookingConfirmed,
  wasEscalated,
  wasItineraryPresented,
  type TravelEmployeeRuntimeConfig
} from "./travel.runtime";

function requireId(call: { id: string } | undefined): string {
  if (!call) throw new Error("expected a tool call");
  return call.id;
}

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
  it("extracts duration in days", () => {
    expect(extractDurationDays("for about 5 days")).toBe(5);
    expect(extractDurationDays("a 10-night trip")).toBe(10);
    expect(extractDurationDays("no duration")).toBeNull();
  });
  it("extracts passenger counts from digits, words, and 'family of N'", () => {
    expect(extractPassengers("we are 3 adults")).toBe(3);
    expect(extractPassengers("two travelers total")).toBe(2);
    expect(extractPassengers("family of 4")).toBe(4);
    expect(extractPassengers("just chatting")).toBeNull();
  });
  it("extracts budgets in lakh, dollar, and rupee notations", () => {
    expect(extractBudget("budget is about 2 lakh")).toEqual({ amount: 200_000, currency: "INR" });
    expect(extractBudget("I can spend $2000")).toEqual({ amount: 2000, currency: "USD" });
    expect(extractBudget("around Rs 50000")).toEqual({ amount: 50_000, currency: "INR" });
    expect(extractBudget("no budget info")).toBeNull();
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
  it("reports COLLECT_DESTINATION as the resting stage for a brand-new conversation", () => {
    const state = deriveTravelState([{ role: "user", content: "hi" }]);
    expect(state.stage).toBe("COLLECT_DESTINATION");
    expect(state.missingFields).toContain("destination");
  });
  it("progresses to CONFIRM_BOOKING once every slot is filled and the itinerary was presented", () => {
    const state = deriveTravelState([
      { role: "user", content: "Dubai in December for 5 days, 2 adults, budget $2000" },
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

  it("greets and asks for the destination on the first turn", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: searchTools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain(config.welcomeMessage);
    expect(result.content).toMatch(/where would you like to travel/i);
  });

  it("never re-asks for a slot already collected, and asks the next missing one", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hi! Where would you like to travel to?" },
        { role: "user", content: "Dubai" }
      ],
      tools: searchTools
    });
    expect(result.content).not.toMatch(/where would you like to travel/i);
    expect(result.content).toMatch(/when are you planning to travel/i);
  });

  it("asks for all remaining missing fields when stuck on an unparseable reply", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [
        { role: "user", content: "Dubai" },
        { role: "assistant", content: "When are you planning to travel?" },
        { role: "user", content: "not sure yet, whenever works" }
      ],
      tools: searchTools
    });
    expect(result.content).toMatch(/still need/i);
  });

  it("emits a search_flights tool call once every slot is filled", async () => {
    const provider = new TravelEmployeeProvider(config);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Dubai in December for 5 days, 2 adults, budget $2000" }],
      tools: searchTools
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
  });

  it("chains search_flights -> search_hotels -> a recommendation with an itinerary summary", async () => {
    const provider = new TravelEmployeeProvider(config);
    const userMessage = { role: "user" as const, content: "Dubai in December for 5 days, 2 adults, budget $2000" };
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

  it("requests CRM lead creation on booking confirmation when the tool is available", async () => {
    const provider = new TravelEmployeeProvider(config);
    const tools = [...searchTools, { name: "connector.dummy-crm.crm.create_lead", description: "", inputSchema: {} }];
    const messages = [
      { role: "user" as const, content: "Dubai in December for 5 days, 2 adults, budget $2000" },
      { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
      { role: "user" as const, content: "yes, confirm" }
    ];
    const result = await provider.complete({ messages, tools });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("connector.dummy-crm.crm.create_lead");
  });

  it("confirms the booking intent directly when no CRM tool is granted", async () => {
    const provider = new TravelEmployeeProvider(config);
    const messages = [
      { role: "user" as const, content: "Dubai in December for 5 days, 2 adults, budget $2000" },
      { role: "assistant" as const, content: "Plan.\n\nReply 'confirm' to proceed with this plan." },
      { role: "user" as const, content: "confirm" }
    ];
    const result = await provider.complete({ messages, tools: searchTools });
    expect(result.content).toMatch(/booking intent has been recorded/i);
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
      messages: [{ role: "user", content: "Dubai in December for 5 days, 2 adults, budget $2000" }],
      tools: []
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/itinerary summary/i);
  });
});
