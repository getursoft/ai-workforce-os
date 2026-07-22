import { describe, expect, it, vi } from "vitest";
import type { AiCompletionRequest, AiCompletionResult, AiMessage, AiProvider } from "@ai-workforce-os/plugin-sdk";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_ENTITY_CONFIRMATION,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  TravelEmployeeLlmOrchestrator,
  buildBelowMinimumMessage,
  buildBudgetGuidanceMessage,
  buildBudgetFeasibilityNote,
  buildCityClarificationMessage,
  buildCityConfirmationMessage,
  buildClarificationConfirmedMessage,
  buildConfirmPrompt,
  buildConvertedEstimateMessage,
  buildDestinationChangedMessage,
  buildNoEstimateToConvertMessage,
  buildOriginRequiredMessage,
  buildPassengerCompositionClarificationMessage,
  buildPassengerCompositionConflictMessage,
  buildReadyToSearchPromptMessage,
  buildSalesHandoffConfirmedMessage,
  buildSalesHandoffFallbackMessage,
  buildToolFailureRecoveryMessage,
  classifyBudgetFeasibility,
  classifyCityConfidence,
  classifyPlanningAction,
  classifyIntentDeterministically,
  computeMissingEntityFields,
  computePassengerState,
  convertCurrencyAmount,
  convertStoredBudgetEstimate,
  detectBudgetModeSignal,
  detectCurrencyConversionRequest,
  detectResponseLanguage,
  deterministicExtractFallback,
  entitiesFromStoredState,
  entitiesToStoredState,
  estimateBudgetRange,
  generatePlaceholderFlights,
  generatePlaceholderHotels,
  hasItineraryFields,
  interpretDatePhrase,
  isExecutionRequest,
  isHotelBudgetModificationRequest,
  lowerHotelStarCategory,
  memoryFromStoredState,
  mergeConfirmedEntities,
  mergeResponseLanguage,
  mergeTravelEntities,
  normalizeCityName,
  parseCityInterpretation,
  parseExtractedEntities,
  parseIntent,
  resolveShortAnswerForLastAskedField,
  toLegacySlots,
  validateBudgetEstimateInputs,
  validateToolTripContext,
  wasItineraryPresented,
  type ConfirmedFieldMeta,
  type StoredBudgetEstimate,
  type TravelEntities,
  type TravelEntityConfirmation
} from "./travel.runtime";

/** Builds confirmation metadata marking every non-null scalar field in `entities` as confirmed. */
function confirmAll(entities: TravelEntities, updatedAt = "2024-01-01T00:00:00.000Z"): TravelEntityConfirmation {
  const meta: ConfirmedFieldMeta = { source: "user", confidence: 1, confirmed: true, updatedAt };
  const confirmation: TravelEntityConfirmation = {};
  for (const key of Object.keys(entities) as Array<keyof TravelEntities>) {
    if (key === "preferences") continue;
    if (entities[key] !== null) confirmation[key] = meta;
  }
  return confirmation;
}

function textResult(content: string): AiCompletionResult {
  return { content, toolCalls: [], provider: "openai-compatible", model: "gpt-4o-mini", usage: {} };
}

/** A scripted fake real-LLM provider: returns queued responses in call order, or a default via `onCall`. */
function fakeProvider(script: {
  extraction?: Record<string, unknown>;
  intent?: string;
  reply?: string;
  onCall?: (request: AiCompletionRequest, callIndex: number) => AiCompletionResult;
}): AiProvider & { calls: AiCompletionRequest[] } {
  const calls: AiCompletionRequest[] = [];
  return {
    calls,
    complete: vi.fn(async (request: AiCompletionRequest) => {
      const index = calls.length;
      calls.push(request);
      if (script.onCall) return script.onCall(request, index);
      const isExtraction = request.messages[0]?.content.includes("information-extraction engine");
      if (isExtraction)
        return textResult(JSON.stringify({ ...(script.extraction ?? {}), intent: script.intent }));
      return textResult(script.reply ?? "Got it.");
    })
  };
}

const config = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

const ITINERARY_PRESENTED_MESSAGE: AiMessage = {
  role: "assistant",
  content: "Here's a plan for your trip...\n\nReply 'confirm' to proceed with this plan, or let me know what you'd like to change."
};

describe("parseExtractedEntities", () => {
  it("parses a well-formed JSON extraction response", () => {
    const parsed = parseExtractedEntities(
      JSON.stringify({
        originCity: "Delhi",
        destinationCity: "London",
        days: 5,
        nights: 4,
        adults: 3,
        budget: 10000,
        budgetCurrency: "usd",
        preferences: ["window seat"]
      })
    );
    expect(parsed).toMatchObject({
      originCity: "Delhi",
      destinationCity: "London",
      days: 5,
      nights: 4,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD",
      preferences: ["window seat"]
    });
  });
  it("tolerates markdown code fences around the JSON", () => {
    const parsed = parseExtractedEntities('```json\n{"destinationCity":"Paris"}\n```');
    expect(parsed.destinationCity).toBe("Paris");
  });
  it("degrades to an empty object on unparsable content", () => {
    expect(parseExtractedEntities("not json at all")).toEqual({});
    expect(parseExtractedEntities("")).toEqual({});
  });
  it("coerces numeric strings and ignores blank strings", () => {
    const parsed = parseExtractedEntities(JSON.stringify({ adults: "3", destinationCity: "" }));
    expect(parsed.adults).toBe(3);
    expect(parsed.destinationCity).toBeNull();
  });
});

describe("mergeTravelEntities", () => {
  it("never overwrites a known value with a newly-extracted null", () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London", adults: 3 };
    const merged = mergeTravelEntities(prior, { destinationCity: null, adults: null, budget: 10000 });
    expect(merged.destinationCity).toBe("London");
    expect(merged.adults).toBe(3);
    expect(merged.budget).toBe(10000);
  });
  it("captures every field present in a single multi-field message", () => {
    const merged = mergeTravelEntities(EMPTY_TRAVEL_ENTITIES, {
      originCity: "Delhi",
      destinationCity: "London",
      days: 5,
      nights: 4,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    });
    expect(merged).toMatchObject({
      originCity: "Delhi",
      destinationCity: "London",
      days: 5,
      nights: 4,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    });
  });
  it("unions preferences instead of replacing them", () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, preferences: ["vegetarian food"] };
    const merged = mergeTravelEntities(prior, { preferences: ["sea view", "vegetarian food"] });
    expect(merged.preferences).toEqual(["vegetarian food", "sea view"]);
  });
});

describe("computeMissingEntityFields", () => {
  it("lists every required field when nothing is known", () => {
    expect(computeMissingEntityFields(EMPTY_TRAVEL_ENTITIES)).toEqual([
      "destinationCity",
      "travelDates",
      "duration",
      "adults",
      "budget"
    ]);
  });
  it("is satisfied by a departureDate as an alternative to travelMonth", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      departureDate: "2026-09-01",
      days: 5,
      adults: 3,
      budget: 10000
    };
    expect(computeMissingEntityFields(entities)).toEqual([]);
  });
  it("is satisfied by nights as an alternative to days", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      nights: 4,
      adults: 3,
      budget: 10000
    };
    expect(computeMissingEntityFields(entities)).toEqual([]);
  });
});

describe("entitiesToStoredState / entitiesFromStoredState", () => {
  it("round-trips the extended entity schema through the legacy-compatible stored shape", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      nights: 4,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    };
    const stored = entitiesToStoredState(entities, "RECOMMEND_OPTIONS");
    expect(stored).toMatchObject({
      destination: "London",
      durationDays: 5,
      passengers: 3,
      budgetAmount: 10000,
      stage: "RECOMMEND_OPTIONS",
      missingFields: []
    });
    expect(entitiesFromStoredState(stored)).toEqual(entities);
  });
  it("reconstructs entities from an older, legacy-only stored document", () => {
    const legacyOnly = {
      destination: "Dubai",
      travelMonth: "December",
      durationDays: 5,
      passengers: 2,
      budgetAmount: 200000,
      budgetCurrency: "INR",
      stage: "RECOMMEND_OPTIONS",
      missingFields: []
    };
    const entities = entitiesFromStoredState(legacyOnly);
    expect(entities.destinationCity).toBe("Dubai");
    expect(entities.days).toBe(5);
    // A legacy document's ambiguous `passengers` count is never assumed to mean "N adults" — it becomes
    // an ambiguous total instead, so composition can still be asked for once (TOTAL_ONLY, not COMPLETE).
    expect(entities.adults).toBeNull();
    expect(entities.totalTravellers).toBe(2);
    expect(entities.budget).toBe(200000);
  });
  it("returns the empty entity set for a missing memory document", () => {
    expect(entitiesFromStoredState(null)).toEqual(EMPTY_TRAVEL_ENTITIES);
  });
});

describe("toLegacySlots", () => {
  it("combines adults and children into the legacy passenger count", () => {
    const slots = toLegacySlots({ ...EMPTY_TRAVEL_ENTITIES, adults: 2, children: 1 });
    expect(slots.passengers).toBe(3);
  });
});

describe("TravelEmployeeLlmOrchestrator", () => {
  it("captures every field from a single multi-field message and asks only for what remains", async () => {
    const real = fakeProvider({
      extraction: {
        originCity: "Delhi",
        destinationCity: "London",
        days: 5,
        nights: 4,
        adults: 3,
        budget: 10000,
        budgetCurrency: "USD"
      },
      reply:
        "Great! I have noted your trip from Delhi to London for 3 adults, 5 days and 4 nights with a budget of USD 10,000. Which month would you like to travel?"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({
      messages: [
        {
          role: "user",
          content: "Plan me a trip from Delhi to London for 5 days 4 nights for 3 adults with a budget of 10000 USD."
        }
      ]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain("Delhi to London");
    expect(orchestrator.lastEntities).toMatchObject({
      originCity: "Delhi",
      destinationCity: "London",
      days: 5,
      nights: 4,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    });
    expect(orchestrator.lastStage).toBe("COLLECT_DATES");
    // Extraction and generation each hit the real provider once.
    expect(real.calls).toHaveLength(2);
  });

  it("never re-asks for a field already captured in a prior turn", async () => {
    const prior: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: { travelMonth: "September" }, reply: "September works — how many days?" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, prior);
    await orchestrator.complete({ messages: [{ role: "user", content: "September please" }] });
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toContain("Never ask for any of these again");
    expect(generationPrompt).not.toContain("Ask ONLY for this one next missing detail: your destination");
  });

  it("offers to search once every required field is known (bug fix: all-fields-complete is not itself authorization), then calls the flight-search tool once the traveler explicitly says go ahead", async () => {
    const prior: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {} });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, prior);
    const offer = await orchestrator.complete({
      messages: [{ role: "user", content: "looks good" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(offer.toolCalls).toEqual([]);
    expect(offer.content).toMatch(/would you like me to look up flight and hotel options/i);
    expect(orchestrator.pendingAction).toBe("SEARCH_OPTIONS");

    const real2 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator.lastEntities, orchestrator.lastMemory);
    const result = await orchestrator2.complete({
      messages: [{ role: "user", content: "yes" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
    expect(orchestrator2.lastStage).toBe("RECOMMEND_OPTIONS");
  });

  it("escalates on request without ever calling the real provider", async () => {
    const real = fakeProvider({});
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "I want to talk to a human agent" }]
    });
    expect(result.content).toContain(config.escalationContact);
    expect(orchestrator.lastStage).toBe("ESCALATED");
    expect(real.calls).toHaveLength(0);
  });

  it("degrades gracefully to a fallback question when the real provider fails", async () => {
    const real: AiProvider = { complete: vi.fn().mockRejectedValue(new Error("boom")) };
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBeTruthy();
    expect(orchestrator.lastEntities).toEqual(EMPTY_TRAVEL_ENTITIES);
  });

  it("continues a flights -> hotels -> recommendation tool chain using the merged entities", async () => {
    const prior: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({});
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, prior);
    const afterFlights = await orchestrator.complete({
      messages: [
        { role: "user", content: "go ahead" },
        { role: "assistant", content: "", toolCallId: "1" },
        {
          role: "tool",
          content: JSON.stringify({
            flightOptions: [{ airline: "SkyLink Air", price: 500, currency: "USD", stops: 0, durationHours: 6 }]
          }),
          toolCallId: "1"
        }
      ],
      tools: [{ name: "travel.search_hotels", description: "", inputSchema: {} }]
    });
    expect(afterFlights.toolCalls[0]?.name).toBe("travel.search_hotels");
    const afterHotels = await orchestrator.complete({
      messages: [
        { role: "user", content: "go ahead" },
        {
          role: "tool",
          content: JSON.stringify({
            hotelOptions: [{ name: "Harbor View Hotel", pricePerNight: 90, currency: "USD", rating: 4.2 }]
          }),
          toolCallId: "2"
        }
      ]
    });
    expect(afterHotels.content).toContain("London");
    expect(afterHotels.content).toContain("Flight options");
  });
});

describe("parseIntent", () => {
  it("reads a valid intent from the extraction response", () => {
    expect(parseIntent(JSON.stringify({ intent: "ask_budget_guidance" }))).toBe("ask_budget_guidance");
  });
  it("defaults to provide_trip_details for a missing, unknown, or unparsable intent", () => {
    expect(parseIntent(JSON.stringify({}))).toBe("provide_trip_details");
    expect(parseIntent(JSON.stringify({ intent: "not_a_real_intent" }))).toBe("provide_trip_details");
    expect(parseIntent("not json at all")).toBe("provide_trip_details");
  });
});

describe("estimateBudgetRange", () => {
  it("scales flights and hotel categories with more travelers", () => {
    const solo = estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London", adults: 1, days: 5 }, config);
    const group = estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London", adults: 3, days: 5 }, config);
    expect(group.low).toBeGreaterThan(solo.low);
    expect(group.high).toBeGreaterThan(solo.high);
    expect(group.breakdown.map((line) => line.label)).toEqual([
      "Flights",
      "Hotel",
      "Food",
      "Local transport",
      "Activities",
      "Visa",
      "Insurance",
      "Contingency"
    ]);
    for (const line of group.breakdown) expect(line.high).toBeGreaterThanOrEqual(line.low);
  });
  it("uses the entity's currency, falling back to the config default", () => {
    expect(estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, budgetCurrency: "INR" }, config).currency).toBe("INR");
    expect(estimateBudgetRange(EMPTY_TRAVEL_ENTITIES, config).currency).toBe(config.defaultCurrency);
  });
});

describe("TravelEmployeeLlmOrchestrator intent routing", () => {
  const completeTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "Delhi",
    destinationCity: "London",
    travelMonth: "September",
    days: 5,
    nights: 4,
    adults: 3,
    budget: 10000,
    budgetCurrency: "USD"
  };

  it("answers a budget-guidance question after the itinerary was already presented, instead of repeating the confirm prompt", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "can you guide me about budget?" }]
    });
    expect(result.content).toContain("Flights");
    expect(result.content).toContain("USD");
    expect(result.content).toMatch(/budget, standard,? or premium/i);
    expect(result.content).not.toContain("Just checking");
    expect(result.content).not.toMatch(/reply 'confirm'/i);
    // Budget guidance is computed deterministically — only the extraction/classification call happens.
    expect(real.calls).toHaveLength(1);
  });

  it("answers a contextual question while trip details are still being collected, then returns to the workflow", async () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London" };
    const real = fakeProvider({
      extraction: {},
      intent: "ask_question",
      reply: "You'll typically need a visa or eTA depending on your passport — happy to help you plan around that."
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, prior);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "do I need a visa for London?" }]
    });
    expect(result.content).toContain("visa");
    const contextualPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(contextualPrompt).toContain("Answer it directly and helpfully first");
    expect(contextualPrompt).toContain("gently ask for");
    expect(contextualPrompt).not.toContain("Ask ONLY for this one next missing detail");
  });

  it("applies a correction to an already-captured field and regenerates the plan instead of asking to confirm the stale one", async () => {
    const real = fakeProvider({ extraction: { destinationCity: "Paris" }, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "not London, Paris" }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Paris");
    expect(result.content).toContain("Paris");
    expect(result.content).not.toContain("London");
  });

  it("never repeats the confirm prompt for a contextual question, and only uses it for a genuinely ambiguous reply", async () => {
    const ambiguous = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const ambiguousOrchestrator = new TravelEmployeeLlmOrchestrator(ambiguous, config, completeTrip);
    const ambiguousResult = await ambiguousOrchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "hmm" }]
    });
    expect(ambiguousResult.content).toMatch(/go ahead|adjust/i);

    const questioning = fakeProvider({ extraction: {}, intent: "ask_recommendation", reply: "I'd lean toward the Central Plaza Inn for the location." });
    const questioningOrchestrator = new TravelEmployeeLlmOrchestrator(questioning, config, completeTrip);
    const questioningResult = await questioningOrchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "which hotel do you recommend?" }]
    });
    expect(questioningResult.content).not.toMatch(/reply 'confirm'/i);
    expect(questioningResult.content).not.toContain("Just checking");
  });

  it("uses human-consultant tone instructions in both the slot-filling and contextual generation prompts", async () => {
    const real = fakeProvider({ extraction: { budget: 8000 }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London" });
    await orchestrator.complete({ messages: [{ role: "user", content: "budget is 8000 USD" }] });
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toContain("human travel consultant");
    expect(generationPrompt).not.toContain("COLLECT_BUDGET");
    expect(generationPrompt).not.toContain("GREETING");
  });

  it("rejects the current plan and asks what to change instead of repeating the full itinerary", async () => {
    const real = fakeProvider({ extraction: {}, intent: "reject_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "no, I don't like this" }]
    });
    expect(result.content).toMatch(/what would you like/i);
    expect(result.content).not.toContain("Flight options");
  });

  it("still confirms and captures a CRM lead when the user genuinely confirms after asking a question earlier", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "confirm" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.crm.create_lead");
  });

  it("mentions both origin and destination and drops placeholder wording in the recommendation", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const offer = await orchestrator.complete({ messages: [{ role: "user", content: "looks good" }] });
    expect(offer.toolCalls).toEqual([]);
    expect(orchestrator.pendingAction).toBe("SEARCH_OPTIONS");
    const real2 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator.lastEntities, orchestrator.lastMemory);
    const result = await orchestrator2.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(result.content).toContain("from Delhi to London");
    expect(result.content).not.toContain("traveler(s)");
    expect(result.content).not.toMatch(/reply 'confirm'/i);
    expect(result.content).toMatch(/adjust the hotel, flights, budget, or dates/i);
    expect(wasItineraryPresented([{ role: "assistant", content: result.content }])).toBe(true);
  });

  it("respects a requested hotel star category, or explains why it substituted a different one", async () => {
    const threeStarTrip: TravelEntities = { ...completeTrip, hotelStars: 3 };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, threeStarTrip);
    await orchestrator.complete({ messages: [{ role: "user", content: "looks good" }] });
    const real1b = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator1b = new TravelEmployeeLlmOrchestrator(real1b, config, orchestrator.lastEntities, orchestrator.lastMemory);
    const result = await orchestrator1b.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(result.content).toContain("Harbor View Hotel");
    expect(result.content).not.toContain("Central Plaza Inn");
    expect(result.content).not.toContain("Palm Court Resort");

    const oneStarTrip: TravelEntities = { ...completeTrip, hotelStars: 1 };
    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, oneStarTrip);
    await orchestrator2.complete({ messages: [{ role: "user", content: "looks good" }] });
    const real2b = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2b = new TravelEmployeeLlmOrchestrator(real2b, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    const result2 = await orchestrator2b.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(result2.content).toMatch(/no 1-star options were available/i);
  });

  it("passes origin and all captured preferences into the search_flights and search_hotels tool calls", async () => {
    const enrichedTrip: TravelEntities = { ...completeTrip, hotelStars: 4, cabinClass: "Business", preferences: ["window seat"] };
    const preReal = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const preOrchestrator = new TravelEmployeeLlmOrchestrator(preReal, config, enrichedTrip);
    await preOrchestrator.complete({ messages: [{ role: "user", content: "looks good" }] });
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      real,
      config,
      preOrchestrator.lastEntities,
      preOrchestrator.lastMemory
    );
    const flightsCall = await orchestrator.complete({
      messages: [{ role: "user", content: "yes" }],
      tools: [
        { name: "travel.search_flights", description: "", inputSchema: {} },
        { name: "travel.search_hotels", description: "", inputSchema: {} }
      ]
    });
    const flightArgs = flightsCall.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(flightArgs).toMatchObject({
      origin: "Delhi",
      destination: "London",
      hotelStars: 4,
      budget: 10000,
      currency: "USD",
      cabinClass: "Business",
      preferences: ["window seat"]
    });

    const hotelsCall = await orchestrator.complete({
      messages: [
        { role: "user", content: "looks good" },
        { role: "assistant", content: "", toolCallId: "1" },
        {
          role: "tool",
          content: JSON.stringify({
            flightOptions: [{ airline: "SkyLink Air", price: 500, currency: "USD", stops: 0, durationHours: 6 }]
          }),
          toolCallId: "1"
        }
      ],
      tools: [{ name: "travel.search_hotels", description: "", inputSchema: {} }]
    });
    const hotelArgs = hotelsCall.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(hotelArgs).toMatchObject({ origin: "Delhi", destination: "London", hotelStars: 4 });
  });
});

describe("normalizeCityName", () => {
  it("corrects a minor typo against the known-destination catalog", () => {
    expect(normalizeCityName("peris")).toBe("Paris");
  });
  it("normalizes casing for an exact known destination", () => {
    expect(normalizeCityName("london")).toBe("London");
  });
  it("leaves an unrelated city title-cased rather than guessing a wrong match", () => {
    expect(normalizeCityName("houston")).toBe("Houston");
  });
  it("returns null for empty or blank input", () => {
    expect(normalizeCityName(null)).toBeNull();
    expect(normalizeCityName("   ")).toBeNull();
  });
  it("keeps the normalized spelling once extracted, so a typo only needs correcting once", () => {
    const extracted = parseExtractedEntities(JSON.stringify({ destinationCity: "peris" }));
    expect(extracted.destinationCity).toBe("Paris");
    const merged = mergeTravelEntities(EMPTY_TRAVEL_ENTITIES, extracted);
    expect(merged.destinationCity).toBe("Paris");
    // A later turn that doesn't mention the destination again must not lose the normalized value.
    const stillMerged = mergeTravelEntities(merged, {});
    expect(stillMerged.destinationCity).toBe("Paris");
  });
});

describe("generatePlaceholderHotels hotel-star preference", () => {
  it("returns only hotels matching the exact requested star category", () => {
    const { hotelOptions, starNote } = generatePlaceholderHotels({ destination: "Paris", hotelStars: 3 });
    expect(hotelOptions.length).toBeGreaterThan(0);
    expect(hotelOptions.every((hotel) => hotel.stars === 3)).toBe(true);
    expect(starNote).toBeNull();
  });
  it("falls back to the closest star category and explains why when no exact match exists", () => {
    const { hotelOptions, starNote } = generatePlaceholderHotels({ destination: "Paris", hotelStars: 1 });
    expect(hotelOptions.every((hotel) => hotel.stars !== 1)).toBe(true);
    expect(starNote).toMatch(/no 1-star options/i);
  });
  it("returns the default two-option spread when no star preference is given", () => {
    const { hotelOptions, starNote } = generatePlaceholderHotels({ destination: "Paris" });
    expect(hotelOptions).toHaveLength(2);
    expect(starNote).toBeNull();
  });
});

describe("budget guidance and search-tool pricing consistency", () => {
  it("derives flight and hotel budget ranges directly from the same placeholder generators the search tools use", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Paris",
      travelMonth: "September",
      adults: 2,
      days: 4,
      nights: 3,
      hotelStars: 4
    };
    const estimate = estimateBudgetRange(entities, config);
    const { flightOptions } = generatePlaceholderFlights({ destination: "Paris", travelMonth: "September", passengers: 2 });
    const { hotelOptions } = generatePlaceholderHotels({ destination: "Paris", travelMonth: "September", hotelStars: 4 });

    const flightsLine = estimate.breakdown.find((line) => line.label === "Flights");
    expect(flightsLine?.low).toBe(Math.min(...flightOptions.map((f) => f.price)));
    expect(flightsLine?.high).toBe(Math.max(...flightOptions.map((f) => f.price)));

    const rooms = Math.max(1, Math.ceil(2 / 2));
    const hotelLine = estimate.breakdown.find((line) => line.label === "Hotel");
    expect(hotelLine?.low).toBe(Math.min(...hotelOptions.map((h) => h.pricePerNight)) * rooms * 3);
    expect(hotelLine?.high).toBe(Math.max(...hotelOptions.map((h) => h.pricePerNight)) * rooms * 3);
  });
});

describe("natural, non-robotic confirmation wording", () => {
  it("buildConfirmPrompt drops placeholder confirm/checking phrasing and offers to adjust hotel, flights, budget or dates", () => {
    const prompt = buildConfirmPrompt();
    expect(prompt).not.toMatch(/reply 'confirm'/i);
    expect(prompt).not.toContain("Just checking");
    expect(prompt).toMatch(/hotel/i);
    expect(prompt).toMatch(/flights/i);
    expect(prompt).toMatch(/budget/i);
    expect(prompt).toMatch(/dates/i);
  });
});

describe("validateBudgetEstimateInputs", () => {
  it("blocks flight estimation when origin is missing, regardless of what else is known", () => {
    const noOrigin: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3,
      budget: 10000
    };
    const validation = validateBudgetEstimateInputs(noOrigin);
    expect(validation.canEstimateFlights).toBe(false);
    expect(validation.missingFields).toContain("originCity");
  });
  it("allows flight estimation once origin is known, even if budget itself is still unknown", () => {
    const withOrigin: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3
    };
    const validation = validateBudgetEstimateInputs(withOrigin);
    expect(validation.canEstimateFlights).toBe(true);
    expect(validation.missingFields).not.toContain("originCity");
  });
});

describe("buildOriginRequiredMessage", () => {
  it("explains why origin is needed and asks only for the departure city", () => {
    const message = buildOriginRequiredMessage();
    expect(message).toMatch(/departure city/i);
    expect(message).toMatch(/varies significantly depending on where you're flying from/i);
    expect(message).toMatch(/which city will you be departing from/i);
    expect(message).not.toMatch(/\d/);
  });
});

describe("budget guidance origin gating (bug fix: no flight/total estimate before origin is known)", () => {
  const config2 = DEFAULT_TRAVEL_EMPLOYEE_CONFIG;

  it("asks only for origin, with no flight figures or total cost, when budget advice is requested cold", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "I need budget advice." }]
    });
    expect(result.content).toMatch(/departure city/i);
    expect(result.content).toMatch(/which city will you be departing from/i);
    expect(result.content).not.toMatch(/flights?:/i);
    expect(result.content).not.toMatch(/hotel:/i);
    expect(result.content).not.toMatch(/\$|USD\s*\d|₹/);
    // The estimator must never even run — only the extraction/classification call happens.
    expect(real.calls).toHaveLength(1);
  });

  it("gives the full flights-through-contingency breakdown once origin is known", async () => {
    const withOrigin: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3
    };
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, withOrigin);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "can you guide me about budget?" }]
    });
    for (const label of ["Flights", "Hotel", "Food", "Local transport", "Activities", "Visa", "Insurance", "Contingency"])
      expect(result.content).toContain(label);
    expect(result.content).not.toMatch(/which city will you be departing from/i);
  });

  it("never calls flight search or shows a recommendation before origin is known, asking for it instead", async () => {
    const noOrigin: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3,
      budget: 10000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, noOrigin);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "looks good" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/which city will you be departing from/i);
    expect(result.content).not.toMatch(/flight options/i);
    expect(orchestrator.lastStage).toBe("ASK_MISSING_INFO");
  });

  it("never contradicts itself: once a turn asks for origin, a later turn with origin supplied estimates flights without asking again", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real1, config2, {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 3
    });
    const firstTurn = await orchestrator.complete({
      messages: [{ role: "user", content: "can you guide me about budget?" }]
    });
    expect(firstTurn.content).not.toMatch(/flights?:/i);
    expect(firstTurn.content).toMatch(/which city will you be departing from/i);

    const real2 = fakeProvider({ extraction: { originCity: "Delhi" }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config2, orchestrator.lastEntities);
    const secondTurn = await orchestrator2.complete({ messages: [{ role: "user", content: "Delhi" }] });
    expect(orchestrator2.lastEntities.originCity).toBe("Delhi");
    // Origin is now known: a later budget question must estimate flights, never re-ask for departure city.
    const real3 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config2, orchestrator2.lastEntities);
    const thirdTurn = await orchestrator3.complete({
      messages: [{ role: "user", content: "so what's the budget looking like?" }]
    });
    expect(thirdTurn.content).toContain("Flights");
    expect(thirdTurn.content).not.toMatch(/which city will you be departing from/i);
    void secondTurn;
  });

  it("buildBudgetGuidanceMessage itself is never invoked by the orchestrator when origin is unknown", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, EMPTY_TRAVEL_ENTITIES);
    const direct = buildBudgetGuidanceMessage(EMPTY_TRAVEL_ENTITIES, config2);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "budget advice please" }] });
    expect(result.content).not.toBe(direct);
    expect(result.content).toBe(buildOriginRequiredMessage());
  });
});

describe("sticky canonical city normalization (bug fix: a re-typed misspelling must never overwrite the canonical spelling)", () => {
  it("keeps an already-canonical destination when a later message re-mistypes the same city", () => {
    const withCanonical: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "Adelaide" };
    const merged = mergeTravelEntities(withCanonical, { destinationCity: "Adelaid" });
    expect(merged.destinationCity).toBe("Adelaide");
  });

  it("still allows a genuine correction to a different city", () => {
    const withDestination: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "Adelaide" };
    const corrected = mergeTravelEntities(withDestination, { destinationCity: "Sydney" });
    expect(corrected.destinationCity).toBe("Sydney");
  });

  it("normalizeCityName corrects the Adelaide typo directly", () => {
    expect(normalizeCityName("Adelaid")).toBe("Adelaide");
  });

  it("persists the canonical destination through budget guidance, recommendation tool calls, and CRM lead capture", async () => {
    const tripInProgress: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "New Delhi",
      destinationCity: "Adelaide",
      travelMonth: "September",
      departureDate: "September 15",
      days: 5,
      nights: 4,
      adults: 2,
      children: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };

    // A later turn's extraction re-surfaces the user's original misspelling — merge must not let it win.
    const real1 = fakeProvider({ extraction: { destinationCity: "Adelaid" }, intent: "ask_budget_guidance" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, tripInProgress);
    const budgetTurn = await orchestrator1.complete({
      messages: [{ role: "user", content: "remind me, what's the budget for Adelaid?" }]
    });
    expect(orchestrator1.lastEntities.destinationCity).toBe("Adelaide");
    expect(budgetTurn.content).toMatch(/Adelaide/);
    expect(budgetTurn.content).not.toMatch(/\bAdelaid\b/);

    // Recommendation stage: canonical spelling must reach the actual tool-call arguments.
    const real2 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities);
    const recTurn = await orchestrator2.complete({
      messages: [{ role: "user", content: "go ahead" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect((recTurn.toolCalls[0]?.arguments as Record<string, unknown>).destination).toBe("Adelaide");

    // CRM lead capture after the itinerary has been shown.
    const real3 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator1.lastEntities);
    const crmTurn = await orchestrator3.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes, confirm" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    const crmArgs = crmTurn.toolCalls[0]?.arguments as { metadata: { destination: string } };
    expect(crmArgs.metadata.destination).toBe("Adelaide");
  });
});

describe("full passenger mix (adults, children, infants) in wording and pricing", () => {
  const family: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "New Delhi",
    destinationCity: "Adelaide",
    travelMonth: "September",
    days: 5,
    nights: 4,
    adults: 2,
    children: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };

  it("never collapses to 'for 2 adults' when children are present in the recommendation intro", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, family);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "go ahead" }] });
    expect(result.content).toContain("2 adults and 2 children");
    expect(result.content).not.toMatch(/for 2 adults,/i);
  });

  it("says '2 adults and 2 children' (not '2 childs') in budget guidance", () => {
    const message = buildBudgetGuidanceMessage(family, config);
    expect(message).toContain("2 adults and 2 children");
    expect(message).not.toContain("childs");
  });

  it("scales the budget estimate with the full adult+child headcount, not adults alone", () => {
    const adultsOnly: TravelEntities = { ...family, children: 0 };
    const withChildren: TravelEntities = { ...family, children: 2 };
    const estimateAdultsOnly = estimateBudgetRange(adultsOnly, config);
    const estimateWithChildren = estimateBudgetRange(withChildren, config);
    expect(estimateWithChildren.low).toBeGreaterThan(estimateAdultsOnly.low);
    expect(estimateWithChildren.high).toBeGreaterThan(estimateAdultsOnly.high);
  });

  it("includes adults, children, and infants in the search tool payload and the CRM lead metadata", async () => {
    const withInfant: TravelEntities = { ...family, infants: 1 };
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, withInfant);
    const searchTurn = await orchestrator.complete({
      messages: [{ role: "user", content: "go ahead" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(searchTurn.toolCalls[0]?.arguments).toMatchObject({ adults: 2, children: 2, infants: 1 });

    const real2 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, withInfant);
    const crmTurn = await orchestrator2.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    const crmArgs = crmTurn.toolCalls[0]?.arguments as { metadata: { adults: number; children: number; infants: number } };
    expect(crmArgs.metadata).toMatchObject({ adults: 2, children: 2, infants: 1 });
  });
});

describe("isExecutionRequest", () => {
  it("recognizes explicit authorization phrases", () => {
    for (const phrase of [
      "yes",
      "go ahead",
      "please proceed",
      "share options",
      "tell me the options",
      "suggest flights and hotels",
      "give me the plan",
      "do that"
    ])
      expect(isExecutionRequest(phrase)).toBe(true);
  });
  it("does not treat an ordinary question as an execution request", () => {
    expect(isExecutionRequest("what is the weather like there?")).toBe(false);
  });
});

describe("isHotelBudgetModificationRequest", () => {
  it("recognizes hotel-cost-reduction phrasing", () => {
    for (const phrase of [
      "can you trim hotels a bit",
      "please reduce hotel cost",
      "any cheaper hotels?",
      "lower the accommodation budget",
      "can you make it fit within 3000 USD"
    ])
      expect(isHotelBudgetModificationRequest(phrase)).toBe(true);
  });
  it("does not match an unrelated budget correction", () => {
    expect(isHotelBudgetModificationRequest("change budget to 12000 USD")).toBe(false);
  });
});

describe("lowerHotelStarCategory", () => {
  it("steps down one catalog tier at a time", () => {
    expect(lowerHotelStarCategory(5)).toEqual({ newStars: 4, hitFloor: false });
    expect(lowerHotelStarCategory(4)).toEqual({ newStars: 3, hitFloor: true });
  });
  it("stays at the cheapest tier once the floor is reached", () => {
    expect(lowerHotelStarCategory(3)).toEqual({ newStars: 3, hitFloor: true });
    expect(lowerHotelStarCategory(null)).toEqual({ newStars: 3, hitFloor: true });
  });
});

describe("MODIFY_HOTEL_BUDGET deterministic action ('trim hotels')", () => {
  const tripWithItinerary: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "New Delhi",
    destinationCity: "Adelaide",
    travelMonth: "September",
    days: 5,
    nights: 4,
    adults: 2,
    children: 2,
    hotelStars: 5,
    budget: 3000,
    budgetCurrency: "USD"
  };

  it("lowers the hotel category, reruns the hotel search, and reports the old estimate, new estimate, and savings", async () => {
    const real = fakeProvider({ extraction: {}, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripWithItinerary);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "can you trim hotels to bring the cost down?" }]
    });
    expect(orchestrator.lastEntities.hotelStars).toBe(4);
    expect(orchestrator.lastEntities.destinationCity).toBe("Adelaide");
    expect(result.content).toMatch(/previous estimate/i);
    expect(result.content).toMatch(/new estimate/i);
    expect(result.content).toMatch(/estimated savings/i);
    // Every other trip entity must be retained untouched.
    expect(orchestrator.lastEntities.originCity).toBe("New Delhi");
    expect(orchestrator.lastEntities.adults).toBe(2);
    expect(orchestrator.lastEntities.children).toBe(2);
  });

  it("never calls the hotel search tool — hotel trimming alone is always deterministic, local repricing (bug fix: 'trim hotel' must never surface as a technical failure)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripWithItinerary);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "reduce hotel cost please" }],
      tools: [{ name: "travel.search_hotels", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/previous estimate/i);
    expect(result.content).toMatch(/new estimate/i);
    expect(result.content).toMatch(/estimated savings/i);
  });

  it("calculates the budget shortfall and confirms achievability once cheaper hotels close the gap", () => {
    const tightBudget: TravelEntities = { ...tripWithItinerary, hotelStars: 4, budget: 100_000, budgetCurrency: "USD" };
    const oldEstimate = estimateBudgetRange({ ...tightBudget, hotelStars: 5 }, config);
    const newEstimate = estimateBudgetRange(tightBudget, config);
    expect(newEstimate.low).toBeLessThanOrEqual(oldEstimate.low);
    // With a very generous budget, the new (cheaper) estimate must clearly be achievable.
    expect(newEstimate.low).toBeLessThanOrEqual(tightBudget.budget ?? 0);
  });

  it("explains further trade-offs are needed once the cheapest hotel tier still doesn't close the gap", async () => {
    const realTight: TravelEntities = { ...tripWithItinerary, hotelStars: 4, budget: 1 };
    const real = fakeProvider({ extraction: {}, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, realTight);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "cheaper hotels please" }]
    });
    expect(orchestrator.lastEntities.hotelStars).toBe(3);
    expect(result.content).toMatch(/most economical hotel category/i);
    expect(result.content).toMatch(/adjusting the dates|trip length|cabin class|activities/i);
  });
});

describe("explicit authorization executes tools immediately (bug fix: no more 'would you like me to...' loop)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "New Delhi",
    destinationCity: "Adelaide",
    travelMonth: "September",
    days: 5,
    nights: 4,
    adults: 2,
    children: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };

  it("'yes' after an offer immediately executes the CRM lead tool rather than replying conversationally", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.crm.create_lead");
    expect(result.content).toBe("");
  });

  it("'suggest flights and hotels' with complete details executes the search tool directly, with no LLM reply-generation call", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "suggest flights and hotels" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
    expect(result.content).not.toMatch(/i can help|would you like me to|want me to find/i);
    // Only the extraction/classification call happens — no separate free-text reply is generated.
    expect(real.calls).toHaveLength(1);
  });

  it("does not create a conversational loop when 'share options' is repeated", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, readyTrip);
    const first = await orchestrator1.complete({
      messages: [{ role: "user", content: "share options" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(first.toolCalls[0]?.name).toBe("travel.search_flights");

    // A second, independent turn with the identical request behaves identically — no drift into a
    // conversational deflection and no repeated "would you like me to" wording.
    const real2 = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, readyTrip);
    const second = await orchestrator2.complete({
      messages: [{ role: "user", content: "share options" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(second.toolCalls[0]?.name).toBe("travel.search_flights");
    expect(second.content).toBe("");
  });
});

describe("validateToolTripContext", () => {
  it("is invalid while origin is unknown", () => {
    const noOrigin: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London", travelMonth: "September", days: 5, adults: 2 };
    expect(validateToolTripContext(noOrigin)).toMatchObject({ valid: false });
  });
  it("is valid once every required field is known", () => {
    const complete: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 2
    };
    expect(validateToolTripContext(complete)).toEqual({ valid: true, missingFields: [] });
  });
});

describe("buildToolFailureRecoveryMessage", () => {
  it("is a friendly, recoverable message with no raw error details", () => {
    const message = buildToolFailureRecoveryMessage();
    expect(message).toMatch(/trip details are saved/i);
    expect(message).toMatch(/retry the search/i);
    expect(message).not.toMatch(/error|exception|stack/i);
  });
});

describe("mergeConfirmedEntities (confirmed-state immutability and field-level updates)", () => {
  const priorValues: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    destinationCity: "Sydney",
    days: 1,
    adults: 5,
    budget: null
  };
  const priorConfirmation = confirmAll(priorValues);

  it("never lets a non-correction turn regress an already-confirmed duration", () => {
    const result = mergeConfirmedEntities(priorValues, priorConfirmation, { days: 5 }, "provide_trip_details");
    expect(result.values.days).toBe(1);
    expect(result.confirmation.days).toBe(priorConfirmation.days);
  });

  it("never lets a non-correction turn regress an already-confirmed traveler count", () => {
    const result = mergeConfirmedEntities(priorValues, priorConfirmation, { adults: 2 }, "ask_question");
    expect(result.values.adults).toBe(5);
  });

  it("an explicit correction (modify_trip) is the only thing that can override a confirmed non-city field", () => {
    const blocked = mergeConfirmedEntities(priorValues, priorConfirmation, { adults: 2 }, "provide_trip_details");
    expect(blocked.values.adults).toBe(5);
    const allowed = mergeConfirmedEntities(priorValues, priorConfirmation, { adults: 2 }, "modify_trip");
    expect(allowed.values.adults).toBe(2);
  });

  it("changing one entity only updates that entity — every other confirmed field is carried forward untouched, never rebuilt", () => {
    const result = mergeConfirmedEntities(priorValues, priorConfirmation, { destinationCity: "Melbourne" }, "modify_trip");
    expect(result.values).toEqual({ ...priorValues, destinationCity: "Melbourne" });
    expect(result.destinationChanged).toEqual({ from: "Sydney", to: "Melbourne" });
  });

  it("allows a city field to be replaced even without modify_trip intent, as long as it is a genuinely different city (not a re-typo)", () => {
    const result = mergeConfirmedEntities(priorValues, priorConfirmation, { destinationCity: "Melbourne" }, "provide_trip_details");
    expect(result.values.destinationCity).toBe("Melbourne");
  });

  it("confirms a field immediately on first mention, without needing a separate confirmation round-trip", () => {
    const result = mergeConfirmedEntities(EMPTY_TRAVEL_ENTITIES, EMPTY_TRAVEL_ENTITY_CONFIRMATION, { days: 1 }, "provide_trip_details");
    expect(result.values.days).toBe(1);
    expect(result.confirmation.days).toMatchObject({ confirmed: true, source: "user" });
  });
});

describe("Orchestrator: confirmed-state persistence across turns (bug fix: confirmed facts must never regress or be re-asked)", () => {
  it("never asks for travelers again once confirmed, and never lets duration regress without an explicit change", async () => {
    const real1 = fakeProvider({ extraction: { destinationCity: "Sydney", days: 1, adults: 5 }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "Sydney, 1 day, 5 travelers" }] });
    expect(orchestrator1.lastEntities.days).toBe(1);
    expect(orchestrator1.lastEntities.adults).toBe(5);
    expect(orchestrator1.confirmation.days?.confirmed).toBe(true);
    expect(orchestrator1.confirmation.adults?.confirmed).toBe(true);

    // Next turn (a fresh orchestrator, exactly as a real HTTP request reconstructs it): the extraction
    // step re-emits a stale "days: 5" without the user ever changing anything, and doesn't restate
    // travelers at all.
    const real2 = fakeProvider({ extraction: { days: 5, budget: 2000 }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    const secondTurn = await orchestrator2.complete({ messages: [{ role: "user", content: "budget is 2000 USD" }] });
    expect(orchestrator2.lastEntities.days).toBe(1);
    expect(orchestrator2.lastEntities.adults).toBe(5);
    expect(secondTurn.content.toLowerCase()).not.toContain("how many travelers");
    expect(computeMissingEntityFields(orchestrator2.lastEntities)).not.toContain("adults");
  });
});

describe("Orchestrator: destination replacement (bug fix: only destination changes, everything else preserved)", () => {
  it("replacing a confirmed destination generates the update acknowledgement and preserves every other confirmed field", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Sydney",
      travelMonth: "September",
      days: 5,
      adults: 3,
      budget: 4000,
      budgetCurrency: "USD",
      preferences: ["window seat"]
    };
    const priorConfirmation = confirmAll(priorValues);
    const real = fakeProvider({ extraction: { destinationCity: "Melbourne" }, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      confirmation: priorConfirmation,
      pendingClarification: null,
      lastAskedField: null,
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null
    });
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "Melbourne" }]
    });
    expect(result.content).toBe(buildDestinationChangedMessage("Sydney", "Melbourne"));
    expect(orchestrator.lastEntities).toEqual({ ...priorValues, destinationCity: "Melbourne" });
  });
});

describe("classifyCityConfidence", () => {
  it("accepts confidence >= 0.85 silently", () => {
    expect(classifyCityConfidence(0.85)).toBe("accept");
    expect(classifyCityConfidence(0.97)).toBe("accept");
  });
  it("asks for a yes/no confirmation in the 0.60-0.84 band", () => {
    expect(classifyCityConfidence(0.6)).toBe("confirm");
    expect(classifyCityConfidence(0.84)).toBe("confirm");
  });
  it("asks an open clarifying question below 0.60", () => {
    expect(classifyCityConfidence(0.59)).toBe("clarify");
    expect(classifyCityConfidence(0)).toBe("clarify");
  });
});

describe("parseCityInterpretation", () => {
  it("parses the rich per-field interpretation shape", () => {
    const raw = JSON.stringify({
      destinationCity: {
        rawValue: "sidni",
        normalizedValue: "Sydney",
        confidence: 0.97,
        inferred: true,
        correctionReason: "phonetic"
      }
    });
    expect(parseCityInterpretation(raw, "destinationCity")).toEqual({
      rawValue: "sidni",
      normalizedValue: "Sydney",
      confidence: 0.97,
      inferred: true,
      correctionReason: "phonetic"
    });
  });
  it("returns null when the field is a plain string rather than the rich shape", () => {
    expect(parseCityInterpretation(JSON.stringify({ destinationCity: "London" }), "destinationCity")).toBeNull();
  });
});

describe("Orchestrator: LLM-first city normalization with confidence gating", () => {
  it("accepts a high-confidence phonetic correction ('sidni' -> Sydney) without asking for confirmation", async () => {
    const real = fakeProvider({
      extraction: {
        destinationCity: {
          rawValue: "sidni",
          normalizedValue: "Sydney",
          confidence: 0.97,
          inferred: true,
          correctionReason: "Likely phonetic misspelling of Sydney"
        }
      },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator.complete({ messages: [{ role: "user", content: "I want to travel to sidni" }] });
    expect(orchestrator.lastEntities.destinationCity).toBe("Sydney");
    expect(orchestrator.pendingClarification).toBeNull();
  });

  it("asks 'Did you mean...?' for a medium-confidence city guess instead of silently accepting it", async () => {
    const real = fakeProvider({
      extraction: {
        destinationCity: { rawValue: "sidne", normalizedValue: "Sydney", confidence: 0.7, inferred: true, correctionReason: null }
      },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "sidne" }] });
    expect(result.content).toBe(buildCityConfirmationMessage("destinationCity", "Sydney"));
    expect(orchestrator.lastEntities.destinationCity).toBeNull();
    expect(orchestrator.pendingClarification).toEqual({
      field: "destinationCity",
      proposedValue: "Sydney",
      rawValue: "sidne",
      confidence: 0.7
    });
  });

  it("asks an open clarifying question for a low-confidence guess", async () => {
    const real = fakeProvider({
      extraction: { destinationCity: { rawValue: "xyz", normalizedValue: "Xyz", confidence: 0.3, inferred: true, correctionReason: null } },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "xyz" }] });
    expect(result.content).toBe(buildCityClarificationMessage("destinationCity", "xyz"));
  });

  it("resolves a pending clarification with a 'yes' on the next turn", async () => {
    const real1 = fakeProvider({
      extraction: {
        destinationCity: { rawValue: "sidne", normalizedValue: "Sydney", confidence: 0.7, inferred: true, correctionReason: null }
      },
      intent: "provide_trip_details"
    });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "sidne" }] });
    expect(orchestrator1.pendingClarification).not.toBeNull();

    const real2 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    await orchestrator2.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(orchestrator2.lastEntities.destinationCity).toBe("Sydney");
    expect(orchestrator2.pendingClarification).toBeNull();
    expect(orchestrator2.confirmation.destinationCity?.confirmed).toBe(true);
  });
});

describe("resolveShortAnswerForLastAskedField (context-sensitive short-input disambiguation)", () => {
  it("interprets a bare '5' as an ambiguous total headcount (not adults) when travelers was last asked about", () => {
    const result = resolveShortAnswerForLastAskedField("5", "adults", {});
    expect(result.totalTravellers).toBe(5);
    expect(result.adults).toBeUndefined();
    expect(result.days).toBeUndefined();
  });
  it("interprets the same bare '5' as duration when duration was last asked about", () => {
    const result = resolveShortAnswerForLastAskedField("5", "duration", {});
    expect(result.days).toBe(5);
    expect(result.adults).toBeUndefined();
  });
  it("does not override a value the model already confidently extracted", () => {
    const result = resolveShortAnswerForLastAskedField("5", "adults", { adults: 2 });
    expect(result.adults).toBe(2);
  });

  it("orchestrator interprets '5' as travelers or duration depending on which field was last asked about", async () => {
    const realA = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestratorA = new TravelEmployeeLlmOrchestrator(realA, config, EMPTY_TRAVEL_ENTITIES, {
      confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      pendingClarification: null,
      lastAskedField: "adults",
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null
    });
    await orchestratorA.complete({ messages: [{ role: "user", content: "5" }] });
    expect(orchestratorA.lastEntities.totalTravellers).toBe(5);
    expect(orchestratorA.lastEntities.adults).toBeNull();

    const realB = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestratorB = new TravelEmployeeLlmOrchestrator(realB, config, EMPTY_TRAVEL_ENTITIES, {
      confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      pendingClarification: null,
      lastAskedField: "duration",
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null
    });
    await orchestratorB.complete({ messages: [{ role: "user", content: "5" }] });
    expect(orchestratorB.lastEntities.days).toBe(5);
  });
});

describe("interpretDatePhrase (natural date enhancement)", () => {
  it("normalizes 'today' to the reference date's ISO date", () => {
    const reference = new Date(Date.UTC(2026, 6, 21));
    const result = interpretDatePhrase("today", reference);
    expect(result.normalizedDate).toBe("2026-07-21");
    expect(result.travelMonth).toBe("July");
  });
  it("normalizes 'tomorrow' relative to the reference date", () => {
    const reference = new Date(Date.UTC(2026, 6, 21));
    expect(interpretDatePhrase("tomorrow", reference).normalizedDate).toBe("2026-07-22");
  });
  it("interprets 'for one week' as a 7-day duration", () => {
    expect(interpretDatePhrase("for one week").durationDays).toBe(7);
  });
  it("interprets an explicit month and day", () => {
    const reference = new Date(Date.UTC(2026, 0, 1));
    const result = interpretDatePhrase("August 15", reference);
    expect(result.normalizedDate).toBe("2026-08-15");
    expect(result.travelMonth).toBe("August");
  });
});

describe("intent enhancement (structured action intents rather than generic conversation)", () => {
  it("recognizes 'I need plan from you' and similar phrases as an execution request", () => {
    expect(isExecutionRequest("i need plan from you")).toBe(true);
    expect(isExecutionRequest("give me options")).toBe(true);
  });
  it("classifyIntentDeterministically maps execution phrases to a request-plan-style fallback intent", () => {
    expect(classifyIntentDeterministically("i need plan from you")).toBe("ask_recommendation");
  });
  it("orchestrator executes the search immediately for 'i need plan from you' once the trip is fully known", async () => {
    const readyTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      confirmation: confirmAll(readyTrip),
      pendingClarification: null,
      lastAskedField: null,
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null
    });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "i need plan from you" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
  });
});

describe("deterministic fallback (bug fix: an LLM outage must not silently drop entities)", () => {
  it("deterministicExtractFallback extracts destination, dates, travelers and budget via regex + catalog normalization", () => {
    const result = deterministicExtractFallback("I want to go to Peris in September for 5 days with 2 adults, budget $3000");
    expect(result.destinationCity).toBe("Paris");
    expect(result.travelMonth).toBe("September");
    expect(result.days).toBe(5);
    // The regex-only fallback cannot distinguish composition from an ambiguous headcount, so it always
    // reports an ambiguous total rather than assuming the wording ("adults") means real composition.
    expect(result.totalTravellers).toBe(2);
    expect(result.adults).toBeUndefined();
    expect(result.budget).toBe(3000);
    expect(result.budgetCurrency).toBe("USD");
  });

  it("orchestrator falls back to deterministic extraction when the real provider throws", async () => {
    const throwingProvider: AiProvider = { complete: vi.fn().mockRejectedValue(new Error("upstream down")) };
    const orchestrator = new TravelEmployeeLlmOrchestrator(throwingProvider, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator.complete({
      messages: [{ role: "user", content: "I want to go to Peris in September for 5 days with 2 adults, budget $3000" }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Paris");
    expect(orchestrator.lastEntities.travelMonth).toBe("September");
    expect(orchestrator.lastEntities.totalTravellers).toBe(2);
    expect(orchestrator.lastEntities.budget).toBe(3000);
  });
});

describe("generation prompts are grounded only in confirmed state", () => {
  it("instructs the model never to invent duration, traveler count, or price beyond confirmed facts", async () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London" };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, prior);
    await orchestrator.complete({ messages: [{ role: "user", content: "hello" }] });
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toContain("Only use the confirmed trip facts");
    expect(generationPrompt).toContain("destination London");
  });
});

describe("conversation memory persistence (confirmation, pending clarification, and last-asked field survive across turns)", () => {
  it("round-trips confirmation, pending clarification, and last-asked field through the stored state document", () => {
    const entities: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "Sydney", days: 1 };
    const confirmation = confirmAll(entities);
    const pendingClarification = { field: "originCity" as const, proposedValue: "Delhi", rawValue: "delih", confidence: 0.7 };
    const stored = entitiesToStoredState(entities, "COLLECT_BUDGET", {
      confirmation,
      pendingClarification,
      lastAskedField: "budget",
      budgetMode: "AGENT_RECOMMENDED",
      pendingAction: "GENERATE_BUDGET_GUIDANCE",
      responseLanguage: "HINGLISH",
      budgetDiscussionCompleted: true,
      lastBudgetEstimate: {
        currency: "USD",
        low: 8787,
        high: 12307,
        breakdown: [{ label: "Flights", low: 1000, high: 1500 }],
        assumptions: "2 adults, 5 day(s) to Sydney, economy class",
        computedAt: "2026-01-01T00:00:00.000Z"
      },
      pendingPassengerConflict: { expectedTotal: 5, candidateAdults: 2, candidateChildren: 2, candidateInfants: null }
    });
    const restoredMemory = memoryFromStoredState(stored);
    expect(restoredMemory.confirmation).toEqual(confirmation);
    expect(restoredMemory.pendingClarification).toEqual(pendingClarification);
    expect(restoredMemory.lastAskedField).toBe("budget");
    expect(restoredMemory.budgetMode).toBe("AGENT_RECOMMENDED");
    expect(restoredMemory.pendingAction).toBe("GENERATE_BUDGET_GUIDANCE");
    expect(restoredMemory.responseLanguage).toBe("HINGLISH");
    expect(restoredMemory.budgetDiscussionCompleted).toBe(true);
    expect(restoredMemory.lastBudgetEstimate?.low).toBe(8787);
    expect(restoredMemory.pendingPassengerConflict).toEqual({
      expectedTotal: 5,
      candidateAdults: 2,
      candidateChildren: 2,
      candidateInfants: null
    });
  });

  it("defaults budgetMode and pendingAction safely for an older stored document that predates this feature", () => {
    const entities: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "Sydney" };
    const stored = entitiesToStoredState(entities, "COLLECT_BUDGET");
    const restoredMemory = memoryFromStoredState(stored);
    expect(restoredMemory.budgetMode).toBe("UNKNOWN");
    expect(restoredMemory.pendingAction).toBeNull();
  });
});

describe("detectBudgetModeSignal (bug fix: 'you suggest'/'no budget' must never be treated as a request for a number)", () => {
  it("maps agent-recommended phrasing to AGENT_RECOMMENDED", () => {
    expect(detectBudgetModeSignal("you suggest your budget")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("you suggest")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("recommend a budget please")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("I need budget advice")).toBe("AGENT_RECOMMENDED");
  });
  it("maps flexible phrasing to FLEXIBLE", () => {
    expect(detectBudgetModeSignal("no budget")).toBe("FLEXIBLE");
    expect(detectBudgetModeSignal("no fixed budget")).toBe("FLEXIBLE");
    expect(detectBudgetModeSignal("my budget is flexible")).toBe("FLEXIBLE");
  });
  it("returns null when the message carries no budget-mode signal", () => {
    expect(detectBudgetModeSignal("I want to go to Paris")).toBeNull();
  });
});

describe("computeMissingEntityFields with budgetMode (bug fix: never require a number when the traveler asked the agent to decide)", () => {
  const readyExceptBudget: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    destinationCity: "London",
    travelMonth: "September",
    days: 5,
    adults: 2
  };
  it("requires budget when budgetMode is UNKNOWN or USER_DEFINED with no amount yet", () => {
    expect(computeMissingEntityFields(readyExceptBudget)).toContain("budget");
    expect(computeMissingEntityFields(readyExceptBudget, "USER_DEFINED")).toContain("budget");
  });
  it("never requires budget when budgetMode is AGENT_RECOMMENDED or FLEXIBLE", () => {
    expect(computeMissingEntityFields(readyExceptBudget, "AGENT_RECOMMENDED")).not.toContain("budget");
    expect(computeMissingEntityFields(readyExceptBudget, "FLEXIBLE")).not.toContain("budget");
  });
});

describe("buildBudgetFeasibilityNote (bug fix: a low budget is a planning constraint to explain, never a technical failure)", () => {
  it("returns null when no budget is stated", () => {
    expect(buildBudgetFeasibilityNote(EMPTY_TRAVEL_ENTITIES, estimateBudgetRange(EMPTY_TRAVEL_ENTITIES, config))).toBeNull();
  });
  it("explains a shortfall (never throws or produces a technical-failure style message) when the budget is well below a realistic estimate", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Kolkata",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 1,
      budget: 1000,
      budgetCurrency: "USD"
    };
    const note = buildBudgetFeasibilityNote(entities, estimateBudgetRange(entities, config));
    expect(note).toMatch(/usd 1,000 budget is about usd \d+ below that/i);
    expect(note).toMatch(/shorter stay/i);
    expect(note).not.toMatch(/couldn't retrieve|technical|error/i);
  });
  it("confirms a comfortable budget rather than raising a false shortfall", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Kolkata",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      adults: 1,
      budget: 50_000,
      budgetCurrency: "USD"
    };
    const note = buildBudgetFeasibilityNote(entities, estimateBudgetRange(entities, config));
    expect(note).toMatch(/comfortable/i);
  });
});

describe("live-conversation regression: welcome branch must never run before extraction", () => {
  it("captures a first-turn misspelled destination and asks for the next missing field, never re-asking for the destination", async () => {
    const real = fakeProvider({
      extraction: {
        destinationCity: {
          rawValue: "peris",
          normalizedValue: "Paris",
          confidence: 0.9,
          inferred: true,
          correctionReason: "Likely phonetic misspelling of Paris"
        }
      },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "I am planning to go to peris" }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Paris");
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).not.toMatch(/begin the reply with/i);
    expect(generationPrompt).toMatch(/already stated trip details/i);
    expect(result.content).not.toMatch(/where would you like to travel/i);
  });
});

describe("live-conversation regression: budget mode and pending-action resumption", () => {
  const londonTripBase: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    destinationCity: "London",
    travelMonth: "September",
    days: 5,
    adults: 2
  };

  it("'you suggest your budget' asks for origin only, then supplying the origin immediately returns a budget estimate — never a repeated numeric-budget question", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, londonTripBase);
    const turn1 = await orchestrator1.complete({
      messages: [{ role: "user", content: "you suggest your budget" }]
    });
    expect(turn1.content).toBe(buildOriginRequiredMessage());
    expect(orchestrator1.pendingAction).toBe("GENERATE_BUDGET_GUIDANCE");
    expect(orchestrator1.budgetMode).toBe("AGENT_RECOMMENDED");

    const real2 = fakeProvider({ extraction: { originCity: "Kolkata" }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const turn2 = await orchestrator2.complete({ messages: [{ role: "user", content: "Kolkata" }] });
    expect(turn2.content).toContain("Flights");
    expect(turn2.content).not.toMatch(/what'?s your approximate budget/i);
    expect(orchestrator2.pendingAction).toBeNull();
    expect(orchestrator2.lastEntities.budget).toBeNull();
  });

  it("a bare 'you suggest' resumes budget guidance deterministically instead of producing free-form (e.g. sightseeing) chat", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, londonTripBase);
    await orchestrator1.complete({ messages: [{ role: "user", content: "you suggest your budget" }] });

    const real2 = fakeProvider({
      extraction: {},
      intent: "ask_recommendation",
      reply: "Here is a five-day sightseeing plan you might enjoy..."
    });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const turn2 = await orchestrator2.complete({ messages: [{ role: "user", content: "you suggest" }] });
    expect(turn2.content).toBe(buildOriginRequiredMessage());
    expect(turn2.content).not.toMatch(/sightseeing/i);
  });

  it("'no budget' is treated as flexible and never triggers a repeated numeric-budget question", async () => {
    const tripWithOrigin: TravelEntities = { ...londonTripBase, originCity: "Kolkata" };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripWithOrigin);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "no budget" }] });
    expect(orchestrator.budgetMode).toBe("FLEXIBLE");
    expect(result.content).not.toMatch(/what'?s your approximate budget/i);
    expect(orchestrator.lastEntities.budget).toBeNull();
  });

  it("'give plan' before all required fields are known asks deterministically for what's missing, never generic free-form chat", async () => {
    const tripMissingOrigin: TravelEntities = {
      ...londonTripBase,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "I can definitely help plan something — want to hear about a few destinations?"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripMissingOrigin);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give plan" }] });
    expect(result.content).toBe(buildOriginRequiredMessage());
    expect(orchestrator.pendingAction).toBe("SEARCH_OPTIONS");
  });

  it("'flight and hotels and budget i need' begins tool execution immediately once every required field is known", async () => {
    const tripReady: TravelEntities = {
      ...londonTripBase,
      originCity: "Kolkata",
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripReady);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "flight and hotels and budget i need" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
  });

  it("a very low stated budget produces a BELOW_MINIMUM feasibility explanation instead of an automatic search, never a technical-failure reply", async () => {
    const tripReady: TravelEntities = {
      ...londonTripBase,
      originCity: "Kolkata",
      adults: 1
    };
    const real = fakeProvider({
      extraction: { budget: 1000, budgetCurrency: "USD" },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripReady);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "1000 USD" }] });
    expect(orchestrator.budgetMode).toBe("USER_DEFINED");
    // No search tool call — a below-minimum budget alone must never trigger an automatic search.
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/minimum budget/i);
    expect(result.content).toMatch(/shorter stay/i);
    expect(result.content).not.toMatch(/couldn't retrieve the options|technical|error/i);
    expect(orchestrator.lastDiagnostics?.feasibility?.classification).toBe("BELOW_MINIMUM");
    expect(orchestrator.lastDiagnostics?.toolExecutionSkippedForFeasibility).toBe(true);
  });
});

describe("live-conversation regression: Hinglish language persistence (bug fix: assistant must not answer in English when the traveler writes Hinglish)", () => {
  it("detects Hinglish from the first turn and retains it across a subsequent turn", async () => {
    const real1 = fakeProvider({ extraction: { destinationCity: "Abu Dhabi" }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "mujhe abu dhabi jana hai" }] });
    expect(orchestrator1.responseLanguage).toBe("HINGLISH");

    const real2 = fakeProvider({
      extraction: { travelMonth: "January", departureDate: "2027-01-01" },
      intent: "provide_trip_details"
    });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    await orchestrator2.complete({ messages: [{ role: "user", content: "1st Jan ko jana hai" }] });
    expect(orchestrator2.responseLanguage).toBe("HINGLISH");
  });

  it("an English-only city name or date phrase never switches an already-established Hinglish conversation back to English", () => {
    expect(mergeResponseLanguage("HINGLISH", detectResponseLanguage("Sydney"))).toBe("HINGLISH");
    expect(mergeResponseLanguage("HINGLISH", detectResponseLanguage("1st Jan"))).toBe("HINGLISH");
  });

  it("classifies plain English and Devanagari Hindi correctly on their own", () => {
    expect(detectResponseLanguage("I want to go to Paris")).toBe("ENGLISH");
    expect(detectResponseLanguage("मुझे दिल्ली जाना है")).toBe("HINDI");
  });

  it("threads the detected language into deterministic response builders (origin-required, budget guidance)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Sydney"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "aap budget suggest karo" }] });
    expect(orchestrator.responseLanguage).toBe("HINGLISH");
    expect(result.content).toBe(buildOriginRequiredMessage("HINGLISH"));
  });
});

describe("live-conversation regression: BELOW_MINIMUM feasibility is a business result, never a technical failure", () => {
  const chennaiToAbuDhabi: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "Chennai",
    destinationCity: "Abu Dhabi",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 2000,
    budgetCurrency: "USD"
  };

  it("classifies a materially insufficient budget (Chennai to Abu Dhabi) as BELOW_MINIMUM and explains it, never a technical failure", async () => {
    const minimum = estimateBudgetRange(chennaiToAbuDhabi, config).low;
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, chennaiToAbuDhabi, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      budgetMode: "USER_DEFINED"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "can you check this" }] });
    expect(orchestrator.lastDiagnostics?.feasibility?.classification).toBe("BELOW_MINIMUM");
    expect(orchestrator.lastDiagnostics?.feasibility?.minimum).toBe(minimum);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).not.toMatch(/couldn't retrieve|technical error/i);
  });

  it("computes the exact shortfall and percentage (e.g. USD 3,443 / ~63% against a USD 5,443 minimum) via classifyBudgetFeasibility", () => {
    const result = classifyBudgetFeasibility(2000, { currency: "USD", low: 5443, high: 6800, breakdown: [] });
    expect(result.classification).toBe("BELOW_MINIMUM");
    expect(result.shortfall).toBe(3443);
    expect(result.shortfallPercent).toBeCloseTo(3443 / 5443, 5);
    expect(result.shortfallPercent).toBeGreaterThan(0.25);
  });

  it("never describes a material (>10%) shortfall as merely 'a little under'", () => {
    const entities: TravelEntities = { ...chennaiToAbuDhabi, destinationCity: "Sydney" };
    const note = buildBudgetFeasibilityNote(entities, estimateBudgetRange(entities, config));
    expect(note).not.toMatch(/a little under/i);
    expect(buildBudgetGuidanceMessage(entities, config)).not.toMatch(/a little under/i);
  });

  it("mentions concrete alternatives (shorter stay, fewer activities, alternate dates, cheaper destination/route) in the BELOW_MINIMUM message", () => {
    const feasibility = classifyBudgetFeasibility(2000, estimateBudgetRange(chennaiToAbuDhabi, config));
    const message = buildBelowMinimumMessage(chennaiToAbuDhabi, feasibility, "ENGLISH");
    expect(message).toMatch(/shorter stay/i);
    expect(message).toMatch(/fewer paid activities/i);
    expect(message).toMatch(/alternate travel dates/i);
    expect(message).toMatch(/lower-cost destination/i);
    expect(message).toMatch(/cheaper airport or route/i);
  });
});

describe("live-conversation regression: clarification confirmation never auto-runs tools (bug fix)", () => {
  it("'Did you mean Sydney?' -> 'Yes' updates only the destination, preserves everything else, and responds naturally without calling any tool", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Melbourne",
      travelMonth: "January",
      days: 5,
      adults: 1,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "Yes" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Sydney");
    expect(orchestrator.lastEntities.originCity).toBe("Chennai");
    expect(orchestrator.lastEntities.budget).toBe(3000);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildClarificationConfirmedMessage("destinationCity", "Sydney"));
    expect(orchestrator.pendingClarification).toBeNull();
    // No extraction/generation call was even made — resolving a clarification is fully deterministic.
    expect(real.calls).toHaveLength(0);
  });

  it("resumes a pending action the user separately requested earlier, once the clarification is confirmed", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Melbourne",
      travelMonth: "January",
      days: 5,
      adults: 1
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "originCity", proposedValue: "Chennai", rawValue: "chenai", confidence: 0.7 },
      pendingAction: "GENERATE_BUDGET_GUIDANCE"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "yes" }] });
    expect(orchestrator.lastEntities.originCity).toBe("Chennai");
    expect(result.content).toContain("Flights");
    expect(orchestrator.pendingAction).toBeNull();
  });
});

describe("live-conversation regression: 'trim hotel' always returns deterministic savings + remaining shortfall (bug fix: must never be a technical failure)", () => {
  it("recomputes savings and the remaining shortfall locally, without calling any tool, even when still below minimum", async () => {
    const tripWithItinerary: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 1,
      hotelStars: 5,
      budget: 500,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripWithItinerary);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "trim hotel" }],
      tools: [{ name: "travel.search_hotels", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/estimated savings/i);
    expect(result.content).toMatch(/still well below/i);
    expect(orchestrator.lastEntities.hotelStars).toBe(4);
  });
});

describe("live-conversation regression: BELOW_MINIMUM sales handoff — callback promised only after a successful CRM save", () => {
  const belowMinimumTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "Chennai",
    destinationCity: "Sydney",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 2000,
    budgetCurrency: "USD"
  };
  const belowMinimumMemory = { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" as const };

  it("creates/updates a CRM lead tagged BUDGET_BELOW_MINIMUM / SALES_FOLLOW_UP_REQUIRED when a CRM tool is available", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, belowMinimumMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "please check" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.crm.create_lead");
    const args = result.toolCalls[0]?.arguments as { metadata?: Record<string, unknown> };
    expect(args.metadata?.budgetStatus).toBe("BUDGET_BELOW_MINIMUM");
    expect(args.metadata?.followUp).toBe("SALES_FOLLOW_UP_REQUIRED");
  });

  it("promises a callback only after the CRM lead save actually succeeds", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, belowMinimumMemory);
    await orchestrator.complete({
      messages: [{ role: "user", content: "please check" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    const followUp = await orchestrator.complete({
      messages: [
        { role: "user", content: "please check" },
        { role: "assistant", content: "", toolCallId: "1" },
        { role: "tool", content: JSON.stringify({ reference: "LEAD-123" }), toolCallId: "1" }
      ]
    });
    expect(followUp.content).toBe(
      `${buildBelowMinimumMessage(belowMinimumTrip, classifyBudgetFeasibility(2000, estimateBudgetRange(belowMinimumTrip, config)), "ENGLISH")}\n\n${buildSalesHandoffConfirmedMessage("ENGLISH")}`
    );
    expect(followUp.content).toMatch(/sales team/i);
    expect(followUp.content).toMatch(/contact you shortly/i);
  });

  it("does not promise a callback when the CRM save does not return a lead reference (soft failure)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, belowMinimumMemory);
    await orchestrator.complete({
      messages: [{ role: "user", content: "please check" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    const followUp = await orchestrator.complete({
      messages: [
        { role: "user", content: "please check" },
        { role: "assistant", content: "", toolCallId: "1" },
        { role: "tool", content: JSON.stringify({ success: false }), toolCallId: "1" }
      ]
    });
    expect(followUp.content).not.toMatch(/contact you shortly/i);
    expect(followUp.content).toBe(
      `${buildBelowMinimumMessage(belowMinimumTrip, classifyBudgetFeasibility(2000, estimateBudgetRange(belowMinimumTrip, config)), "ENGLISH")}\n\n${buildSalesHandoffFallbackMessage("ENGLISH")}`
    );
  });

  it("skips the CRM call entirely and shows only the feasibility explanation when no CRM tool is available", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, belowMinimumMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "please check" }] });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/minimum budget/i);
  });
});

describe("live-conversation regression: total traveller count vs passenger composition (bug fix: '5 log' must not be discarded or conflated with adults)", () => {
  it("'5 log hai aur budget hai 2000 USD' stores totalTravellers=5 and the budget, without touching adults", async () => {
    const real = fakeProvider({
      extraction: { totalTravellers: 5, budget: 2000, budgetCurrency: "USD" },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator.complete({
      messages: [{ role: "user", content: "5 log hai aur budget hai 2000 USD" }]
    });
    expect(orchestrator.lastEntities.totalTravellers).toBe(5);
    expect(orchestrator.lastEntities.adults).toBeNull();
    expect(orchestrator.lastEntities.budget).toBe(2000);
    expect(computePassengerState(orchestrator.lastEntities)).toBe("TOTAL_ONLY");
    expect(computeMissingEntityFields(orchestrator.lastEntities)).not.toContain("adults");
  });

  it("supplying the origin afterwards updates only the origin — total travellers, budget, dates, and destination are all preserved, and traveller count is never asked again", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      totalTravellers: 5,
      budget: 2000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: { originCity: "New Delhi" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "New Delhi" }] });
    // All other fields survive untouched — only origin changed.
    expect(orchestrator.lastEntities.originCity).toBe("New Delhi");
    expect(orchestrator.lastEntities.totalTravellers).toBe(5);
    expect(orchestrator.lastEntities.budget).toBe(2000);
    expect(orchestrator.lastEntities.destinationCity).toBe("London");
    expect(orchestrator.lastEntities.travelMonth).toBe("September");
    expect(orchestrator.lastEntities.days).toBe(5);
    // Never the generic "how many travelers?" question again — the total is already known, so with
    // everything else now complete it asks specifically for the composition breakdown instead.
    expect(result.content).not.toMatch(/how many travelers\?|kitne log travel karenge/i);
  });

  it("asks for the adults/children/infants breakdown before an actual search when only a total is known", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "New Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      totalTravellers: 5,
      budget: 2000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripTotalOnly);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "ok great" }] });
    expect(result.content).toBe(buildPassengerCompositionClarificationMessage(5, "ENGLISH"));
    expect(result.content).toContain("Five travellers noted");
    expect(result.toolCalls).toEqual([]);
  });

  it("'2 adults 2 kids 1 infant' resolves the composition, totals to 5, and marks passenger state COMPLETE", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "New Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      totalTravellers: 5,
      budget: 2000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: { adults: 2, children: 2, infants: 1 }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripTotalOnly);
    await orchestrator.complete({ messages: [{ role: "user", content: "2 adults 2 kids 1 infant" }] });
    expect(orchestrator.lastEntities.adults).toBe(2);
    expect(orchestrator.lastEntities.children).toBe(2);
    expect(orchestrator.lastEntities.infants).toBe(1);
    expect(orchestrator.lastEntities.totalTravellers).toBe(5);
    expect(computePassengerState(orchestrator.lastEntities)).toBe("COMPLETE");
  });

  it("a composition that conflicts with a previously stated total asks for clarification instead of silently overwriting either number", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "New Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      totalTravellers: 5,
      budget: 2000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: { adults: 2, children: 1 }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripTotalOnly);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "2 adults 1 kid" }] });
    expect(result.content).toBe(buildPassengerCompositionConflictMessage(5, 3, "ENGLISH"));
    expect(orchestrator.lastEntities.adults).toBeNull();
    expect(orchestrator.lastEntities.totalTravellers).toBe(5);
  });

  it("a user correction that updates composition preserves every other trip field", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "New Delhi",
      destinationCity: "London",
      travelMonth: "September",
      days: 5,
      totalTravellers: 5,
      budget: 2000,
      budgetCurrency: "USD",
      hotelStars: 4
    };
    const real = fakeProvider({ extraction: { adults: 2, children: 2, infants: 1 }, intent: "modify_trip" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripTotalOnly);
    await orchestrator.complete({ messages: [{ role: "user", content: "2 adults 2 kids 1 infant" }] });
    expect(orchestrator.lastEntities.originCity).toBe("New Delhi");
    expect(orchestrator.lastEntities.destinationCity).toBe("London");
    expect(orchestrator.lastEntities.travelMonth).toBe("September");
    expect(orchestrator.lastEntities.days).toBe(5);
    expect(orchestrator.lastEntities.budget).toBe(2000);
    expect(orchestrator.lastEntities.hotelStars).toBe(4);
  });

  it("the generated acknowledgement prompt only lists values actually merged into confirmed state, never raw numbers the workflow discarded", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator.complete({ messages: [{ role: "user", content: "5 log hai aur budget hai 2000 USD" }] });
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toContain("No new trip details were captured this turn");
    expect(generationPrompt).toMatch(/do not acknowledge or confirm any of them/i);
    expect(orchestrator.lastEntities.totalTravellers).toBeNull();
    expect(orchestrator.lastEntities.budget).toBeNull();
  });
});

describe("classifyPlanningAction (deterministic, LLM-independent request routing)", () => {
  it("classifies the required example phrases", () => {
    expect(classifyPlanningAction("Mujhe day plan karke batao")).toBe("GENERATE_ITINERARY");
    expect(classifyPlanningAction("kaha ghumna chahiye")).toBe("RECOMMEND_ATTRACTIONS");
    expect(classifyPlanningAction("what's the budget looking like")).toBe("CALCULATE_BUDGET");
    expect(classifyPlanningAction("show me hotel options")).toBe("SEARCH_HOTELS");
    expect(classifyPlanningAction("show me flight options")).toBe("SEARCH_FLIGHTS");
  });
  it("never classifies a hotel-budget-modification request as a hotel search — that has its own dedicated flow", () => {
    expect(classifyPlanningAction("trim hotels to bring the cost down")).toBeNull();
    expect(classifyPlanningAction("reduce hotel cost please")).toBeNull();
  });
  it("never classifies a plain statement mentioning 'budget' as a budget question", () => {
    expect(classifyPlanningAction("Plan me a trip with a budget of 10000 USD")).not.toBe("CALCULATE_BUDGET");
  });
});

describe("live-conversation regression: BELOW_MINIMUM must not hijack unrelated requests (bug fix)", () => {
  const belowMinimumTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "Chennai",
    destinationCity: "Paris",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 800,
    budgetCurrency: "USD"
  };
  // Simulates a conversation where the BELOW_MINIMUM explanation was already shown once.
  const alreadyInformedMemory = { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" as const, budgetDiscussionCompleted: true };

  it("asking about attractions after BELOW_MINIMUM returns attractions, never the budget explanation again", async () => {
    const real = fakeProvider({
      extraction: {},
      intent: "ask_question",
      reply: "Paris me Eiffel Tower, Louvre Museum aur Seine river cruise zaroor dekhein."
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, alreadyInformedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "Paris me ghumne layak kya kya hai" }]
    });
    expect(result.content).toContain("Eiffel Tower");
    expect(result.content).not.toMatch(/minimum budget|shorter stay|below that/i);
    expect(result.toolCalls).toEqual([]);
  });

  it("asking for a day plan after BELOW_MINIMUM returns an itinerary, never the budget explanation again, and budget is not blocked from generating it", async () => {
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n09:00 Hotel check-in\n11:00 Eiffel Tower (2 hours)\n13:30 Lunch\n15:00 Seine cruise\n17:00 Champs-Élysées"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, alreadyInformedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "Mujhe day plan karke batao" }]
    });
    expect(result.content).toContain("Day 1");
    expect(result.content).toContain("Eiffel Tower");
    expect(result.content).not.toMatch(/minimum budget|shorter stay|below that/i);
    expect(result.toolCalls).toEqual([]);
    // Itinerary generation clears any stale pending action rather than leaving BELOW_MINIMUM state active.
    expect(orchestrator.pendingAction).toBeNull();
  });

  it("explicitly asking about budget again after BELOW_MINIMUM still returns the feasibility explanation", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, alreadyInformedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "what's the budget looking like" }]
    });
    expect(result.content).toMatch(/minimum budget|shorter stay|below that/i);
  });

  it("explicitly asking about hotels after BELOW_MINIMUM still returns the feasibility explanation", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, alreadyInformedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "show me hotel options" }]
    });
    expect(result.content).toMatch(/minimum budget|shorter stay|below that/i);
    expect(result.toolCalls).toEqual([]);
  });

  it("explicitly asking about flights after BELOW_MINIMUM still returns the feasibility explanation", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, alreadyInformedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "show me flight options" }]
    });
    expect(result.content).toMatch(/minimum budget|shorter stay|below that/i);
    expect(result.toolCalls).toEqual([]);
  });
});

describe("live-conversation regression: CONVERT_ESTIMATE_CURRENCY (bug fix: 'give in INR' must convert, not ask for a new budget)", () => {
  it("classifies 'give in INR' / 'INR me batao' / 'convert to rupees' as CONVERT_ESTIMATE_CURRENCY, never CALCULATE_BUDGET", () => {
    expect(classifyPlanningAction("give in INR")).toBe("CONVERT_ESTIMATE_CURRENCY");
    expect(classifyPlanningAction("INR me batao")).toBe("CONVERT_ESTIMATE_CURRENCY");
    expect(classifyPlanningAction("convert to rupees")).toBe("CONVERT_ESTIMATE_CURRENCY");
    expect(detectCurrencyConversionRequest("give in INR")).toEqual({ targetCurrency: "INR" });
  });

  it("converts every number in the persisted estimate with one FX rate — never relabels unchanged amounts", () => {
    const estimate: StoredBudgetEstimate = {
      currency: "USD",
      low: 8787,
      high: 12307,
      breakdown: [{ label: "Flights", low: 1000, high: 1500 }],
      assumptions: "2 adults, 5 day(s) to Paris, economy class",
      computedAt: "2026-01-01T00:00:00.000Z"
    };
    const converted = convertStoredBudgetEstimate(estimate, "INR");
    expect(converted.currency).toBe("INR");
    // Numerically converted (rate 83), never the same digits merely relabeled.
    expect(converted.low).toBe(convertCurrencyAmount(8787, "USD", "INR"));
    expect(converted.low).not.toBe(8787);
    expect(converted.high).not.toBe(12307);
    expect(converted.breakdown[0]?.low).toBe(convertCurrencyAmount(1000, "USD", "INR"));
    // Converting to the same currency never touches the numbers.
    expect(convertStoredBudgetEstimate(estimate, "USD")).toEqual(estimate);

    const message = buildConvertedEstimateMessage(converted, "ENGLISH");
    expect(message).toContain("INR");
    expect(message).not.toContain("8,787");
    expect(message).not.toContain("12,307");
  });

  it("'give in INR' converts the last stored estimate rather than asking for a new budget amount", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Paris",
      travelMonth: "January",
      days: 5,
      adults: 2,
      budget: 20000,
      budgetCurrency: "USD"
    };
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, trip);
    const usdEstimate = await orchestrator1.complete({ messages: [{ role: "user", content: "what's the budget?" }] });
    expect(usdEstimate.content).toContain("USD");

    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    const inrEstimate = await orchestrator2.complete({ messages: [{ role: "user", content: "give in INR" }] });
    expect(inrEstimate.content).toContain("INR");
    expect(inrEstimate.content).not.toMatch(/what'?s your approximate budget|which city will you be departing/i);
    // The real.calls length being 1 (extraction only) proves no new budget-ask generation happened.
    expect(real2.calls).toHaveLength(1);
  });

  it("politely explains there is nothing to convert yet when no estimate has been shown", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give in INR" }] });
    expect(result.content).toBe(buildNoEstimateToConvertMessage("ENGLISH"));
  });
});

describe("live-conversation regression: GENERATE_ITINERARY never requires passenger composition (bug fix)", () => {
  it("'mujhe trip wise day optimise krke btao' is classified as GENERATE_ITINERARY", () => {
    expect(classifyPlanningAction("mujhe trip wise day optimise krke btao")).toBe("GENERATE_ITINERARY");
  });

  it("generates an itinerary without ever asking for adults/children/infants, even when passenger composition is entirely unknown", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Paris",
      travelMonth: "January",
      days: 5
    };
    expect(hasItineraryFields(trip)).toBe(true);
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n09:00 Louvre Museum\n13:00 Lunch\n15:00 Seine river cruise"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "mujhe trip wise day optimise krke btao" }]
    });
    expect(result.content).toContain("Day 1");
    expect(result.content).not.toMatch(/how many are adults|passenger composition|adults, children/i);
    expect(result.toolCalls).toEqual([]);
  });
});

describe("live-conversation regression: passenger-conflict candidate patching (bug fix: '1 infant' must patch the stored candidate, not be interpreted alone)", () => {
  it("a single-field correction after a conflict patches the stored candidate and reconciles the total", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      totalTravellers: 5
    };
    const real1 = fakeProvider({ extraction: { adults: 2, children: 2 }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, tripTotalOnly);
    const conflictResult = await orchestrator1.complete({ messages: [{ role: "user", content: "2 adults 2 kids" }] });
    expect(conflictResult.content).toBe(buildPassengerCompositionConflictMessage(5, 4, "ENGLISH"));
    expect(orchestrator1.lastEntities.adults).toBeNull();

    const real2 = fakeProvider({ extraction: { infants: 1 }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    await orchestrator2.complete({ messages: [{ role: "user", content: "1 infant" }] });
    expect(orchestrator2.lastEntities.adults).toBe(2);
    expect(orchestrator2.lastEntities.children).toBe(2);
    expect(orchestrator2.lastEntities.infants).toBe(1);
    expect(orchestrator2.lastEntities.totalTravellers).toBe(5);
    expect(computePassengerState(orchestrator2.lastEntities)).toBe("COMPLETE");
    expect(orchestrator2.pendingPassengerConflict).toBeNull();
  });
});

describe("live-conversation regression: clarification resolution never itself authorizes search (bug fix)", () => {
  it("resuming a stored GENERATE_ITINERARY pending action after a clarification generates the itinerary, not a search", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Melbourne",
      travelMonth: "January",
      days: 5
    };
    const real = fakeProvider({
      extraction: {},
      intent: "confirm_plan",
      reply: "Day 1\n09:00 Great Ocean Road\n13:00 Lunch"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 },
      pendingAction: "GENERATE_ITINERARY"
    });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "yes" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Sydney");
    expect(result.content).toContain("Day 1");
    expect(result.toolCalls).toEqual([]);
    expect(orchestrator.pendingAction).toBeNull();
  });

  it("with no pending action stored, resolving a clarification only acknowledges — it never calls a search tool", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Melbourne",
      travelMonth: "January",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingClarification: { field: "destinationCity", proposedValue: "Sydney", rawValue: "sidni", confidence: 0.7 }
    });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "yes" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(orchestrator.lastEntities.destinationCity).toBe("Sydney");
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildClarificationConfirmedMessage("destinationCity", "Sydney"));
  });
});

describe("live-conversation regression: completing passenger composition never itself authorizes a search (bug fix)", () => {
  it("'2 adults 2 kids 1 infant' completing the trip offers options instead of executing an unrequested search", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      totalTravellers: 5,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: { adults: 2, children: 2, infants: 1 }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, tripTotalOnly);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "2 adults 2 kids 1 infant" }],
      tools: [
        { name: "travel.search_flights", description: "", inputSchema: {} },
        { name: "travel.search_hotels", description: "", inputSchema: {} }
      ]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildReadyToSearchPromptMessage("ENGLISH"));
    expect(orchestrator.pendingAction).toBe("SEARCH_OPTIONS");
  });
});

describe("live-conversation regression: language sticky but switchable (bug fix: many Hinglish turns must reliably switch the language)", () => {
  it("switches from HINDI to HINGLISH (and back) on a meaningful turn in either direction — not just upward", () => {
    expect(mergeResponseLanguage("HINDI", detectResponseLanguage("mujhe trip plan karna hai"))).toBe("HINGLISH");
    expect(mergeResponseLanguage("HINGLISH", detectResponseLanguage("मुझे दिल्ली जाना है"))).toBe("HINDI");
  });

  it("a plain, marker-less message never resets an established Hinglish/Hindi conversation back to English", () => {
    expect(mergeResponseLanguage("HINGLISH", detectResponseLanguage("Sydney"))).toBe("HINGLISH");
    expect(mergeResponseLanguage("HINDI", detectResponseLanguage("5"))).toBe("HINDI");
  });

  it("reliably switches across several consecutive Hinglish turns in an actual conversation", async () => {
    const real1 = fakeProvider({ extraction: { destinationCity: "Paris" }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "mujhe Paris jana hai" }] });
    expect(orchestrator1.responseLanguage).toBe("HINGLISH");

    const real2 = fakeProvider({ extraction: { travelMonth: "January" }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    await orchestrator2.complete({ messages: [{ role: "user", content: "January mein jaana chahta hoon" }] });
    expect(orchestrator2.responseLanguage).toBe("HINGLISH");

    const real3 = fakeProvider({ extraction: { days: 5 }, intent: "provide_trip_details" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    await orchestrator3.complete({ messages: [{ role: "user", content: "5 din ke liye" }] });
    expect(orchestrator3.responseLanguage).toBe("HINGLISH");
  });
});

describe("live-conversation regression: personalized itinerary generation (bug fix: generated itinerary must reflect known passenger composition)", () => {
  it("threads adults/children/infants, dates, and an infant slower-pace instruction into the itinerary generation prompt", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      destinationCity: "Paris",
      departureDate: "2026-01-10",
      returnDate: "2026-01-15",
      days: 5,
      adults: 2,
      children: 2,
      infants: 1
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Louvre Museum" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    await orchestrator.complete({ messages: [{ role: "user", content: "day plan please" }] });
    const itineraryPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(itineraryPrompt).toContain("2 adults, 2 children and 1 infant");
    expect(itineraryPrompt).toContain("2026-01-10");
    expect(itineraryPrompt).toMatch(/slower pace|rest\/nap/i);
    expect(itineraryPrompt).toMatch(/opening hours vary by season/i);
  });
});
