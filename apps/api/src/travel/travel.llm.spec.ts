import { describe, expect, it, vi } from "vitest";
import type { AiCompletionRequest, AiCompletionResult, AiMessage, AiProvider } from "@ai-workforce-os/plugin-sdk";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  EMPTY_TRAVEL_ENTITY_CONFIRMATION,
  EMPTY_TRAVEL_CONVERSATION_MEMORY,
  PROVIDER_FAILURE_MENU_TTL_MS,
  TravelEmployeeLlmOrchestrator,
  buildBelowMinimumMessage,
  buildBudgetGuidanceMessage,
  buildBudgetFeasibilityNote,
  buildFarewellMessage,
  isFarewellMessage,
  guardReturnDateAssumption,
  deriveDurationFromDateRange,
  parseExplicitTravelDate,
  resolveTravelYear,
  augmentWithExplicitDate,
  guardNightsVsHotelStars,
  guardYearNotBudget,
  detectYearClarification,
  hasMonetaryContext,
  buildCityClarificationMessage,
  buildCityConfirmationMessage,
  buildClarificationConfirmedMessage,
  buildCompleteTripPlan,
  buildCompleteTripPlanMessage,
  buildJourneyCompleteTripPlan,
  buildCompletionOfferMessage,
  buildContactRequestMessage,
  buildInvalidPhoneMessage,
  buildPendingContactAcknowledgement,
  buildLeadAlreadyCapturedMessage,
  buildLeadCapturedMessage,
  buildLeadConversationSummary,
  formatPassengerSummaryForLead,
  buildConfirmPrompt,
  buildConvertedEstimateMessage,
  buildDisplayCurrencySetMessage,
  buildCurrencyAckWithSearchPromptMessage,
  buildAlreadyInCurrencyMessage,
  buildUnsupportedCurrencyMessage,
  buildConversionUnavailableMessage,
  convertBudgetEstimate,
  convertStoredBudgetEstimateSafe,
  validateBudgetEstimatePlausibility,
  PRICING_SOURCE_CURRENCY,
  buildDestinationChangedMessage,
  buildDurationAssumptionNote,
  buildDurationPhrase,
  buildHotelRecommendationsMessage,
  buildRequestedAreaGuidance,
  extractHotelArea,
  buildIndicativeRecommendationsMessage,
  buildMultiLegAddedMessage,
  buildOriginRequiredMessage,
  buildPassengerCompositionClarificationMessage,
  buildPassengerCompositionConflictMessage,
  buildPreferenceApplicationNote,
  buildReadyToSearchPromptMessage,
  buildTravellerCostFactorNote,
  buildSalesHandoffConfirmedMessage,
  buildSalesHandoffFallbackMessage,
  buildToolFailureRecoveryMessage,
  buildTripLegAddedMessage,
  buildMultilegCorrectionMessage,
  buildRouteRelationshipClarificationMessage,
  buildReturnDateProjectionMessage,
  describeJourneyRoute,
  extractStayOverrideForCity,
  projectJourneyReturnDate,
  classifyRouteRelationship,
  classifyBudgetFeasibility,
  classifyCityConfidence,
  classifyPlanningAction,
  classifyIntentDeterministically,
  computeMissingEntityFields,
  computePassengerState,
  buildRecoveryContinuationMessage,
  convertCurrencyAmount,
  convertStoredBudgetEstimate,
  describeTravellerCostBreakdown,
  detectBudgetModeSignal,
  detectCurrencyConversionRequest,
  detectPassengerCorrectionMode,
  detectProviderFailureRecoverySelection,
  detectResponseLanguage,
  detectTravellerPreferenceFlags,
  deriveNextLegDepartureDate,
  deterministicExtractFallback,
  countryOf,
  entitiesFromStoredState,
  entitiesToStoredState,
  estimateBudgetRange,
  estimateJourneyBudgetRange,
  isDomesticTrip,
  generatePlaceholderFlights,
  generatePlaceholderHotels,
  hasItineraryFields,
  missingBookingFields,
  parseItineraryText,
  validateItineraryText,
  interpretDatePhrase,
  isExecutionRequest,
  isExplicitLiveOptionsRequest,
  isHotelBudgetModificationRequest,
  isRecoveryMenuActive,
  lowerHotelStarCategory,
  memoryFromStoredState,
  mergeConfirmedEntities,
  mergeResponseLanguage,
  mergeTravelEntities,
  normalizeCityName,
  parseCityInterpretation,
  parseExtractedEntities,
  parseIntent,
  parseJourneyLegChain,
  reconcileBudgetEstimate,
  reconcileJourneyBudgetEstimate,
  resolveDurationSource,
  resolveShortAnswerForLastAskedField,
  renderJourneyCompleteTripPlan,
  toJourneyLeg,
  toLegacySlots,
  validateBudgetEstimateInputs,
  validateCompleteTripPlan,
  validateJourneyCompleteTripPlan,
  validateToolTripContext,
  wasItineraryPresented,
  type ConfirmedFieldMeta,
  type Journey,
  type JourneyLeg,
  type JourneyTravellerProfile,
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
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London", adults: 3 };
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
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", preferences: ["vegetarian food"] };
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const slots = toLegacySlots({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", adults: 2, children: 1 });
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "I want to talk to a human agent" }]
    });
    expect(result.content).toContain(config.escalationContact);
    expect(orchestrator.lastStage).toBe("ESCALATED");
    expect(real.calls).toHaveLength(0);
  });

  it("degrades gracefully to a fallback question when the real provider fails", async () => {
    const real: AiProvider = { complete: vi.fn().mockRejectedValue(new Error("boom")) };
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBeTruthy();
    expect(orchestrator.lastEntities).toEqual({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
  });

  it("continues a flights -> hotels -> recommendation tool chain using the merged entities", async () => {
    const prior: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const solo = estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London", adults: 1, days: 5 }, config);
    const group = estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London", adults: 3, days: 5 }, config);
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
    expect(estimateBudgetRange({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", budgetCurrency: "INR" }, config).currency).toBe("INR");
    expect(estimateBudgetRange(EMPTY_TRAVEL_ENTITIES, config).currency).toBe(config.defaultCurrency);
  });

  it("never includes Visa or Insurance for a domestic trip (Kolkata -> Delhi, both in India)", () => {
    // Reproduces the reported bug: a 6-traveller, 5-day domestic Indian trip must never carry a visa or
    // international-insurance assumption.
    const estimate = estimateBudgetRange(
      { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Kolkata", destinationCity: "Delhi", adults: 6, days: 5 },
      config
    );
    const labels = estimate.breakdown.map((line) => line.label);
    expect(labels).not.toContain("Visa");
    expect(labels).not.toContain("Insurance");
    expect(labels).toEqual(["Flights", "Hotel", "Food", "Local transport", "Activities", "Contingency"]);
    // The total is exactly the sum of the (domestic-only) breakdown lines — no silently-zeroed line item
    // still contributing to the headline number.
    expect(estimate.low).toBe(labels.reduce((sum, label) => sum + (estimate.breakdown.find((l) => l.label === label)?.low ?? 0), 0));
  });

  it("still includes Visa and Insurance for a genuinely international trip (Delhi -> London)", () => {
    const estimate = estimateBudgetRange(
      { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "London", adults: 2, days: 5 },
      config
    );
    const labels = estimate.breakdown.map((line) => line.label);
    expect(labels).toContain("Visa");
    expect(labels).toContain("Insurance");
  });

  it("still includes Visa and Insurance when the origin is unknown (never assumes domestic without positive confirmation)", () => {
    const estimate = estimateBudgetRange(
      { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Delhi", adults: 2, days: 5 },
      config
    );
    const labels = estimate.breakdown.map((line) => line.label);
    expect(labels).toContain("Visa");
    expect(labels).toContain("Insurance");
  });

  it("excludes Visa/Insurance for other domestic pairs too (Mumbai -> Bangalore) — not a Delhi-specific hack", () => {
    const estimate = estimateBudgetRange(
      { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Mumbai", destinationCity: "Bangalore", adults: 1, days: 3 },
      config
    );
    const labels = estimate.breakdown.map((line) => line.label);
    expect(labels).not.toContain("Visa");
    expect(labels).not.toContain("Insurance");
  });
});

describe("isDomesticTrip / countryOf", () => {
  it.each([
    ["Kolkata", "Delhi"],
    ["Mumbai", "Bangalore"],
    ["Delhi", "Goa"],
    ["Chennai", "Hyderabad"]
  ])("classifies %s -> %s as domestic (both India)", (origin, destination) => {
    expect(isDomesticTrip(origin, destination)).toBe(true);
  });

  it.each([
    ["Delhi", "London"],
    ["Mumbai", "Dubai"],
    ["Kolkata", "Paris"],
    ["London", "Delhi"]
  ])("classifies %s -> %s as international", (origin, destination) => {
    expect(isDomesticTrip(origin, destination)).toBe(false);
  });

  it("never classifies as domestic when either city is unrecognized", () => {
    expect(isDomesticTrip("Kolkata", "Atlantis")).toBe(false);
    expect(isDomesticTrip("Atlantis", "Delhi")).toBe(false);
    expect(isDomesticTrip(null, "Delhi")).toBe(false);
    expect(isDomesticTrip("Delhi", null)).toBe(false);
  });

  it("countryOf is case/whitespace-insensitive and returns null for unknown cities", () => {
    expect(countryOf("  DELHI  ")).toBe("India");
    expect(countryOf("london")).toBe("UK");
    expect(countryOf("Atlantis")).toBeNull();
    expect(countryOf(null)).toBeNull();
  });
});

describe("TravelEmployeeLlmOrchestrator intent routing", () => {
  const completeTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London" };
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London" });
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

  it("still moves into lead capture when the user genuinely confirms after asking a question earlier", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "confirm" }]
    });
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
  });

  it("a bare Hinglish 'ji' after a presented plan also moves into lead capture, deterministically (even if the LLM's own intent label misses it)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, completeTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "ji" }]
    });
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config2, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
    const direct = buildBudgetGuidanceMessage(EMPTY_TRAVEL_ENTITIES, config2);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "budget advice please" }] });
    expect(result.content).not.toBe(direct);
    expect(result.content).toBe(buildOriginRequiredMessage());
  });
});

describe("sticky canonical city normalization (bug fix: a re-typed misspelling must never overwrite the canonical spelling)", () => {
  it("keeps an already-canonical destination when a later message re-mistypes the same city", () => {
    const withCanonical: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Adelaide" };
    const merged = mergeTravelEntities(withCanonical, { destinationCity: "Adelaid" });
    expect(merged.destinationCity).toBe("Adelaide");
  });

  it("still allows a genuine correction to a different city", () => {
    const withDestination: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Adelaide" };
    const corrected = mergeTravelEntities(withDestination, { destinationCity: "Sydney" });
    expect(corrected.destinationCity).toBe("Sydney");
  });

  it("normalizeCityName corrects the Adelaide typo directly", () => {
    expect(normalizeCityName("Adelaid")).toBe("Adelaide");
  });

  it("persists the canonical destination through budget guidance, recommendation tool calls, and lead capture", async () => {
    const tripInProgress: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

    // Lead capture after the itinerary has been shown — a phone number in the same message goes straight
    // to the travel.create_lead tool call.
    const real3 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator1.lastEntities);
    const leadTurn = await orchestrator3.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes, confirm, call me at +919876543210" }]
    });
    expect(leadTurn.toolCalls[0]?.name).toBe("travel.create_lead");
    const leadArgs = leadTurn.toolCalls[0]?.arguments as { destination: string };
    expect(leadArgs.destination).toBe("Adelaide");
  });
});

describe("full passenger mix (adults, children, infants) in wording and pricing", () => {
  const family: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

  it("bug fix: '3 rat' (nights, no days stated) is shown as '3 night(s)' in the summary sentence, never silently relabeled '3 days'", () => {
    const threeNightsOnly: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, originCity: "Delhi", destinationCity: "London", adults: 3, nights: 3, days: null };
    const message = buildBudgetGuidanceMessage(threeNightsOnly, config);
    expect(message).toContain("3 night(s)");
    expect(message).not.toMatch(/3 day/i);
    expect(message).not.toMatch(/4 day/i);
  });

  it("scales the budget estimate with the full adult+child headcount, not adults alone", () => {
    const adultsOnly: TravelEntities = { ...family, children: 0 };
    const withChildren: TravelEntities = { ...family, children: 2 };
    const estimateAdultsOnly = estimateBudgetRange(adultsOnly, config);
    const estimateWithChildren = estimateBudgetRange(withChildren, config);
    expect(estimateWithChildren.low).toBeGreaterThan(estimateAdultsOnly.low);
    expect(estimateWithChildren.high).toBeGreaterThan(estimateAdultsOnly.high);
  });

  it("includes adults, children, and infants in the search tool payload and the lead's passenger summary", async () => {
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
    const leadTurn = await orchestrator2.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes, call me on +919876543210" }]
    });
    const leadArgs = leadTurn.toolCalls[0]?.arguments as { passengers: string };
    expect(leadArgs.passengers).toBe("2 adults, 2 children, 1 infant");
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
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

  it("'yes' after an offer moves straight into lead capture rather than replying conversationally", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes" }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
  });

  it("'yes' with a phone number already in the same message executes the lead-capture tool immediately", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "yes, call me on +919876543210" }]
    });
    expect(result.toolCalls[0]?.name).toBe("travel.create_lead");
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
    const noOrigin: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London", travelMonth: "September", days: 5, adults: 2 };
    expect(validateToolTripContext(noOrigin)).toMatchObject({ valid: false });
  });
  it("is valid once every required field is known", () => {
    const complete: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
    });
    const result = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "Melbourne" }]
    });
    expect(result.content).toBe(buildDestinationChangedMessage("Sydney", "Melbourne"));
    expect(orchestrator.lastEntities).toEqual({ ...priorValues, destinationCity: "Melbourne" });
  });

  it("Stage 9G: bare year '2026' is accepted when system asked for travel year — no generic numeric-rejection", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Tokyo",
      travelMonth: "October",
      days: 5,
      adults: 2,
      budget: 200000,
      budgetCurrency: "INR"
    };
    const priorConfirmation = confirmAll(priorValues);
    // System state: pending departure date awaiting year clarification
    const real = fakeProvider({ extraction: { departureDate: "2026-10-01" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      confirmation: priorConfirmation,
      pendingClarification: null,
      lastAskedField: "travelYear",
      budgetMode: "USER_DEFINED",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingDepartureDate: { day: 1, month: 10, year: null, source: "USER_EXPLICIT" },
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
    });
    const result = await orchestrator.complete({
      messages: [
        { role: "assistant", content: "I have 1 October. Which year should I use?" },
        { role: "user", content: "2026" }
      ]
    });
    // The bare number "2026" should NOT trigger the generic numeric guard
    // The year should be applied to the departure date
    expect(result.content).not.toMatch(/share.*(text|response)/i);
    expect(result.content).not.toMatch(/Kripya/i);
    // The departure date should include 2026
    expect(orchestrator.lastEntities.departureDate).toMatch(/2026/);
  });

  it("Stage 9G: changing destination without modify_trip clears ALL old trip-specific state (Dubai→Tokyo must not leak travellers, dates, duration, budget)", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Dubai",
      originCity: "Mumbai",
      travelMonth: "September",
      days: 5,
      adults: 3,
      totalTravellers: 3,
      budget: 50000,
      budgetCurrency: "AED",
      preferences: ["vegetarian"]
    };
    const priorConfirmation = confirmAll(priorValues);
    // The LLM returns "provide_trip_details" (not modify_trip) — the destination
    // change from Dubai to Tokyo must NOT carry any old trip-specific fields forward.
    // Only destinationCity and the user-level fields (customerName, preferences) survive.
    const real = fakeProvider({ extraction: { destinationCity: "Tokyo" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorValues, {
      confirmation: priorConfirmation,
      pendingClarification: null,
      lastAskedField: null,
      budgetMode: "USER_DEFINED",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: true,
      lastBudgetEstimate: { low: 40000, high: 60000, currency: "AED", breakdown: [], assumptions: "", computedAt: "2026-01-01T00:00:00.000Z", displayCurrency: "AED", availabilityType: "INDICATIVE" as const },
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: "Day 1 visit Dubai Mall",
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
    });
    const { content } = await orchestrator.complete({
      messages: [ITINERARY_PRESENTED_MESSAGE, { role: "user", content: "Tokyo ka trip plan kro" }]
    });
    // The response should NOT contain AED or the old 50000 budget
    expect(content).not.toMatch(/AED|50000/);
    // All old trip-specific entity fields are cleared
    expect(orchestrator.lastEntities.budget).toBeNull();
    expect(orchestrator.lastEntities.budgetCurrency).toBeNull();
    expect(orchestrator.lastEntities.originCity).toBeNull();
    expect(orchestrator.lastEntities.travelMonth).toBeNull();
    expect(orchestrator.lastEntities.departureDate).toBeNull();
    expect(orchestrator.lastEntities.days).toBeNull();
    expect(orchestrator.lastEntities.nights).toBeNull();
    expect(orchestrator.lastEntities.adults).toBeNull();
    expect(orchestrator.lastEntities.totalTravellers).toBeNull();
    // Stored estimate and itinerary are cleared
    expect(orchestrator.lastMemory.lastBudgetEstimate).toBeNull();
    expect(orchestrator.lastMemory.lastGeneratedItinerary).toBeNull();
    expect(orchestrator.lastMemory.budgetDiscussionCompleted).toBe(false);
    // Customer name and preferences survive
    expect(orchestrator.lastEntities.customerName).toBe("Alex");
    expect(orchestrator.lastEntities.preferences).toContain("vegetarian");
    // Destination is now Tokyo
    expect(orchestrator.lastEntities.destinationCity).toBe("Tokyo");
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    const orchestratorA = new TravelEmployeeLlmOrchestrator(realA, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" }, {
      confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      pendingClarification: null,
      lastAskedField: "adults",
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
    });
    await orchestratorA.complete({ messages: [{ role: "user", content: "5" }] });
    expect(orchestratorA.lastEntities.totalTravellers).toBe(5);
    expect(orchestratorA.lastEntities.adults).toBeNull();

    const realB = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestratorB = new TravelEmployeeLlmOrchestrator(realB, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" }, {
      confirmation: EMPTY_TRAVEL_ENTITY_CONFIRMATION,
      pendingClarification: null,
      lastAskedField: "duration",
      budgetMode: "UNKNOWN",
      pendingAction: null,
      responseLanguage: "ENGLISH",
      budgetDiscussionCompleted: false,
      lastBudgetEstimate: null,
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      pendingPassengerConflict: null,
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
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
    // "Adults" is an explicit age category, so deterministic extraction preserves the composition.
    expect(result.totalTravellers).toBe(2);
    expect(result.adults).toBe(2);
    expect(result.budget).toBe(3000);
    expect(result.budgetCurrency).toBe("USD");
  });

  it("orchestrator falls back to deterministic extraction when the real provider throws", async () => {
    const throwingProvider: AiProvider = { complete: vi.fn().mockRejectedValue(new Error("upstream down")) };
    const orchestrator = new TravelEmployeeLlmOrchestrator(throwingProvider, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London" };
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
    const entities: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Sydney", days: 1 };
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
      pendingPassengerConflict: { expectedTotal: 5, candidateAdults: 2, candidateChildren: 2, candidateInfants: null },
      journey: null,
      lastGeneratedItinerary: null,
      providerFailure: null,
      completionStage: "NOT_OFFERED",
      capturedLeadReference: null,
      displayCurrency: null,
      pendingRouteClarification: null,
      pendingRecommendations: null,
      selectedRecommendationId: null,
      passengerDetails: null,
      pendingResendLookup: null,
      ticketContact: null
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
    const entities: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Sydney" };
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

  it("Stage 9F UAT regression: 'budget is open' and its typo/garbled variants map to FLEXIBLE", () => {
    expect(detectBudgetModeSignal("budget is open")).toBe("FLEXIBLE");
    expect(detectBudgetModeSignal("budget is openb")).toBe("FLEXIBLE");
    expect(detectBudgetModeSignal("budget is open boss")).toBe("FLEXIBLE");
    expect(detectBudgetModeSignal("open budget")).toBe("FLEXIBLE");
  });

  it("Stage 9F UAT regression: 'you estimate (budget)' maps to AGENT_RECOMMENDED", () => {
    expect(detectBudgetModeSignal("you estimate budget")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("you estimate")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("you estimate the budget")).toBe("AGENT_RECOMMENDED");
  });

  it("Stage 9F UAT regression: 'give me your estimate/an estimate' now maps to AGENT_RECOMMENDED (explicit UAT requirement)", () => {
    expect(detectBudgetModeSignal("give me your estimate")).toBe("AGENT_RECOMMENDED");
    expect(detectBudgetModeSignal("give me an estimate")).toBe("AGENT_RECOMMENDED");
  });
});

describe("computeMissingEntityFields with budgetMode (bug fix: never require a number when the traveler asked the agent to decide)", () => {
  const readyExceptBudget: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Sydney"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "aap budget suggest karo" }] });
    expect(orchestrator.responseLanguage).toBe("HINGLISH");
    expect(result.content).toBe(buildOriginRequiredMessage("HINGLISH"));
  });
});

describe("live-conversation regression: BELOW_MINIMUM feasibility is a business result, never a technical failure", () => {
  const chennaiToAbuDhabi: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

describe("Stage 9E: TravelRuntimeExecutionMode for the BELOW_MINIMUM budget trigger", () => {
  const chennaiToAbuDhabi: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Abu Dhabi",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 2000,
    budgetCurrency: "USD"
  };

  it("STANDALONE_COMPATIBILITY (the default, unaffected by Stage 9E) still transitions pendingInputAction/completionStage directly and never emits a workflow signal", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, chennaiToAbuDhabi, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      budgetMode: "USER_DEFINED"
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "can you check this" }] });
    expect(orchestrator.completionStage).toBe("AWAITING_CONTACT");
    expect(orchestrator.pendingInputAction).toBe("AWAITING_LEAD_CONTACT");
    expect(orchestrator.lastWorkflowSignal).toBeNull();
  });

  it("PLATFORM_MANAGED additionally emits a typed START_TRIP_SUBMISSION signal, with the identical user-facing message and legacy memory transition (self-healing fallback if the signal dispatch itself ever fails)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const standalone = new TravelEmployeeLlmOrchestrator(
      real,
      config,
      chennaiToAbuDhabi,
      { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" }
    );
    const standaloneResult = await standalone.complete({
      messages: [{ role: "user", content: "can you check this" }]
    });

    const platformManaged = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      chennaiToAbuDhabi,
      { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" },
      "PLATFORM_MANAGED"
    );
    const platformManagedResult = await platformManaged.complete({
      messages: [{ role: "user", content: "can you check this" }]
    });

    expect(platformManagedResult.content).toBe(standaloneResult.content);
    expect(platformManaged.completionStage).toBe(standalone.completionStage);
    expect(platformManaged.pendingInputAction).toBe(standalone.pendingInputAction);
    expect(standalone.lastWorkflowSignal).toBeNull();
    expect(platformManaged.lastWorkflowSignal).toEqual({
      signalType: "START_TRIP_SUBMISSION",
      trigger: "BELOW_MINIMUM_BUDGET"
    });
  });

  it("lastWorkflowSignal is reset every turn — it never leaks into a later, unrelated turn", async () => {
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      chennaiToAbuDhabi,
      { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" },
      "PLATFORM_MANAGED"
    );
    await orchestrator.complete({ messages: [{ role: "user", content: "can you check this" }] });
    expect(orchestrator.lastWorkflowSignal).not.toBeNull();

    orchestrator.pendingInputAction = null;
    await orchestrator.complete({
      messages: [
        { role: "user", content: "can you check this" },
        { role: "assistant", content: "..." },
        { role: "user", content: "what about attractions there" }
      ]
    });
    expect(orchestrator.lastWorkflowSignal).toBeNull();
  });

  it("Stage 9E.1: PLATFORM_MANAGED never takes the legacy CRM-tool sales-handoff branch, even when a CRM tool is available — it emits the same signal and never calls the CRM tool directly", async () => {
    const platformManaged = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      chennaiToAbuDhabi,
      { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, budgetMode: "USER_DEFINED" },
      "PLATFORM_MANAGED"
    );
    const result = await platformManaged.complete({
      messages: [{ role: "user", content: "can you check this" }],
      tools: [{ name: "travel.crm.create_lead", description: "", inputSchema: {} }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/minimum budget/i);
    expect(result.content).toMatch(/mobile number/i);
    expect(platformManaged.lastWorkflowSignal).toEqual({
      signalType: "START_TRIP_SUBMISSION",
      trigger: "BELOW_MINIMUM_BUDGET"
    });
  });
});

describe("live-conversation regression: clarification confirmation never auto-runs tools (bug fix)", () => {
  it("'Did you mean Sydney?' -> 'Yes' updates only the destination, preserves everything else, and responds naturally without calling any tool", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

  it("bug fix: still saves the internal TravelLead once a phone number is given, even with no CRM tool ever available — CRM availability must never gate the internal lead", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, belowMinimumTrip, belowMinimumMemory);
    const offer = await orchestrator.complete({ messages: [{ role: "user", content: "please check" }] });
    expect(offer.toolCalls).toEqual([]);
    expect(offer.content).toMatch(/minimum budget/i);
    expect(offer.content).toMatch(/mobile number|phone/i);
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");

    const withPhone = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      orchestrator.lastEntities,
      orchestrator.lastMemory
    );
    const captured = await withPhone.complete({ messages: [{ role: "user", content: "+919876543210" }] });
    expect(captured.toolCalls[0]?.name).toBe("travel.create_lead");
    const args = captured.toolCalls[0]?.arguments as { phoneNumber: string };
    expect(args.phoneNumber).toBe("+919876543210");
  });
});

describe("live-conversation regression: total traveller count vs passenger composition (bug fix: '5 log' must not be discarded or conflated with adults)", () => {
  it("'5 log hai aur budget hai 2000 USD' stores totalTravellers=5 and the budget, without touching adults", async () => {
    const real = fakeProvider({
      extraction: { totalTravellers: 5, budget: 2000, budgetCurrency: "USD" },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

  it("stating two or more passenger categories together is a full replacement of the candidate — commits immediately, zeroing any unmentioned category, even against a conflicting prior total", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    expect(result.content).not.toBe(buildPassengerCompositionConflictMessage(5, 3, "ENGLISH"));
    expect(orchestrator.lastEntities.adults).toBe(2);
    expect(orchestrator.lastEntities.children).toBe(1);
    expect(orchestrator.lastEntities.infants).toBe(0);
    expect(orchestrator.lastEntities.totalTravellers).toBe(3);
    expect(orchestrator.pendingPassengerConflict).toBeNull();
  });

  it("a user correction that updates composition preserves every other trip field", async () => {
    const tripTotalOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

  it("deterministically captures generic totals and budgets even when the model misses them", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
    await orchestrator.complete({ messages: [{ role: "user", content: "5 log hai aur budget hai 2000 USD" }] });
    const generationPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toContain("totalTravellers=5");
    expect(generationPrompt).toContain("budget=2000");
    expect(orchestrator.lastEntities.totalTravellers).toBe(5);
    expect(orchestrator.lastEntities.budget).toBe(2000);
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
  it("classifies an explicit booking go-ahead, including Hinglish SOV phrasing, as BOOK_FLIGHT", () => {
    expect(classifyPlanningAction("flight book kar do")).toBe("BOOK_FLIGHT");
    expect(classifyPlanningAction("book the flight")).toBe("BOOK_FLIGHT");
    expect(classifyPlanningAction("book my flight please")).toBe("BOOK_FLIGHT");
    expect(classifyPlanningAction("flights book kar dijiye")).toBe("BOOK_FLIGHT");
  });
  it("a plain browse/search ask is still SEARCH_FLIGHTS, not BOOK_FLIGHT", () => {
    expect(classifyPlanningAction("show me flight options")).toBe("SEARCH_FLIGHTS");
    expect(classifyPlanningAction("which flights are available")).toBe("SEARCH_FLIGHTS");
  });
});

describe("detectPassengerCorrectionMode (parser: PATCH vs FULL_REPLACEMENT)", () => {
  it("classifies exactly one mentioned category as PATCH", () => {
    expect(detectPassengerCorrectionMode({ infants: 1 })).toBe("PATCH");
    expect(detectPassengerCorrectionMode({ children: 2 })).toBe("PATCH");
    expect(detectPassengerCorrectionMode({ adults: 3 })).toBe("PATCH");
  });
  it("classifies two or more mentioned categories as FULL_REPLACEMENT", () => {
    expect(detectPassengerCorrectionMode({ adults: 2, children: 1 })).toBe("FULL_REPLACEMENT");
    expect(detectPassengerCorrectionMode({ children: 2, infants: 1 })).toBe("FULL_REPLACEMENT");
    expect(detectPassengerCorrectionMode({ adults: 2, children: 1, infants: 0 })).toBe("FULL_REPLACEMENT");
  });
  it("treats null/undefined fields as not mentioned — zero categories mentioned still defaults to PATCH", () => {
    expect(detectPassengerCorrectionMode({ adults: 2, children: null, infants: undefined })).toBe("PATCH");
    expect(detectPassengerCorrectionMode({})).toBe("PATCH");
  });
});

describe("live-conversation regression: BELOW_MINIMUM must not hijack unrelated requests (bug fix)", () => {
  const belowMinimumTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      reply: "Day 1\n14:00 Hotel check-in\n15:30 Eiffel Tower (2 hours)\n18:00 Dinner"
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

  it("supports AED end to end: detection, real conversion (not a relabel), and the rendered message", () => {
    expect(classifyPlanningAction("show in AED")).toBe("CONVERT_ESTIMATE_CURRENCY");
    expect(detectCurrencyConversionRequest("convert it to dirhams")).toEqual({ targetCurrency: "AED" });
    const estimate: StoredBudgetEstimate = {
      currency: "USD",
      low: 6000,
      high: 8000,
      breakdown: [{ label: "Flights", low: 1000, high: 1500 }],
      assumptions: "2 adults, 5 day(s) to Dubai, economy class",
      computedAt: "2026-01-01T00:00:00.000Z"
    };
    const converted = convertStoredBudgetEstimate(estimate, "AED");
    expect(converted.currency).toBe("AED");
    expect(converted.low).not.toBe(6000);
    expect(converted.low).toBe(convertCurrencyAmount(6000, "USD", "AED"));
    const message = buildConvertedEstimateMessage(converted, "ENGLISH");
    expect(message).toContain("AED");
    expect(message).not.toContain("6,000");
  });

  it("'give in INR' converts the last stored estimate rather than asking for a new budget amount", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    // A currency preference is now handled fully deterministically, ahead of extraction — so it makes NO
    // LLM call at all (never a fresh budget-ask generation, and never even an extraction round-trip).
    expect(real2.calls).toHaveLength(0);
    // The original budget constraint is untouched — only the display currency changed.
    expect(orchestrator2.lastEntities.budgetCurrency).toBe("USD");
    expect(orchestrator2.lastMemory.displayCurrency).toBe("INR");
  });

  it("acknowledges a currency change and records the display preference when no estimate exists yet (never a search)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give in INR" }] });
    expect(result.content).toBe(buildDisplayCurrencySetMessage("INR", "ENGLISH"));
    expect(result.toolCalls).toEqual([]);
    expect(orchestrator.lastMemory.displayCurrency).toBe("INR");
  });
});

describe("live-conversation regression: GENERATE_ITINERARY never requires passenger composition (bug fix)", () => {
  it("'mujhe trip wise day optimise krke btao' is classified as GENERATE_ITINERARY", () => {
    expect(classifyPlanningAction("mujhe trip wise day optimise krke btao")).toBe("GENERATE_ITINERARY");
  });

  it("generates an itinerary without ever asking for adults/children/infants, even when passenger composition is entirely unknown", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Paris",
      travelMonth: "January",
      days: 5
    };
    expect(hasItineraryFields(trip)).toBe(true);
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n14:00 Louvre Museum\n16:30 Seine river cruise\n19:00 Dinner"
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      totalTravellers: 5
    };
    // Each turn mentions exactly one passenger category (PATCH mode) so the candidate is built up
    // incrementally and re-checked against the previously stated total each time — two or more categories
    // mentioned together would instead be a FULL_REPLACEMENT, see the classifyPlanningAction describe block.
    const real1 = fakeProvider({ extraction: { adults: 2 }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, tripTotalOnly);
    const conflictResult1 = await orchestrator1.complete({ messages: [{ role: "user", content: "2 adults" }] });
    expect(conflictResult1.content).toBe(buildPassengerCompositionConflictMessage(5, 2, "ENGLISH"));
    expect(orchestrator1.lastEntities.adults).toBeNull();

    const real2 = fakeProvider({ extraction: { children: 2 }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const conflictResult2 = await orchestrator2.complete({ messages: [{ role: "user", content: "kids 2" }] });
    expect(conflictResult2.content).toBe(buildPassengerCompositionConflictMessage(5, 4, "ENGLISH"));

    const real3 = fakeProvider({ extraction: { infants: 1 }, intent: "provide_trip_details" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(
      real3,
      config,
      orchestrator2.lastEntities,
      orchestrator2.lastMemory
    );
    await orchestrator3.complete({ messages: [{ role: "user", content: "1 infant" }] });
    expect(orchestrator3.lastEntities.adults).toBe(2);
    expect(orchestrator3.lastEntities.children).toBe(2);
    expect(orchestrator3.lastEntities.infants).toBe(1);
    expect(orchestrator3.lastEntities.totalTravellers).toBe(5);
    expect(computePassengerState(orchestrator3.lastEntities)).toBe("COMPLETE");
    expect(orchestrator3.pendingPassengerConflict).toBeNull();
  });
});

describe("live-conversation regression: clarification resolution never itself authorizes search (bug fix)", () => {
  it("resuming a stored GENERATE_ITINERARY pending action after a clarification generates the itinerary, not a search", async () => {
    const priorValues: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex" });
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
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
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

describe("missingBookingFields (BOOK_FLIGHT's own required-fields check)", () => {
  it("never includes budget, unlike computeMissingEntityFields", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2
    };
    expect(missingBookingFields(trip)).toEqual([]);
    expect(computeMissingEntityFields(trip)).toEqual(["budget"]);
  });
  it("lists destination/dates/duration/adults when absent, in that order", () => {
    expect(missingBookingFields(EMPTY_TRAVEL_ENTITIES)).toEqual([
      "destinationCity",
      "travelDates",
      "duration",
      "adults"
    ]);
  });
  it("treats a TOTAL_ONLY headcount as satisfying the passenger requirement", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      totalTravellers: 4
    };
    expect(missingBookingFields(trip)).toEqual([]);
  });
});

describe("live-conversation regression: BOOK_FLIGHT must survive every clarification and never fall back to budget collection (bug fix)", () => {
  it("flight book kar do -> persists BOOK_FLIGHT, never asks for budget, collects only booking-required fields", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2,
      children: 1
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "flight book kar do" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(orchestrator.pendingAction).toBe("BOOK_FLIGHT");
    expect(result.content).toBe(buildOriginRequiredMessage("ENGLISH"));
  });

  it("a budget question mid-booking is answered but leaves BOOK_FLIGHT pending for the next turn to resume", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2
    };
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      pendingAction: "BOOK_FLIGHT"
    });
    await orchestrator.complete({
      messages: [{ role: "user", content: "what's the budget looking like" }],
      tools: [{ name: "travel.search_flights", description: "", inputSchema: {} }]
    });
    expect(orchestrator.pendingAction).toBe("BOOK_FLIGHT");
  });

  it("full regression: Estimate -> Book flight -> Budget aside -> Passenger conflict -> Replacement -> Search resumes", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      totalTravellers: 5
    };
    const tools = [{ name: "travel.search_flights", description: "", inputSchema: {} }];

    // 1. Estimate: a plain budget question, answered normally — nothing booking-related pending yet.
    const real1 = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, trip);
    const result1 = await orchestrator1.complete({
      messages: [{ role: "user", content: "what's the budget looking like" }],
      tools
    });
    expect(result1.toolCalls).toEqual([]);
    expect(orchestrator1.pendingAction).toBeNull();

    // 2. Book flight: an explicit go-ahead persists BOOK_FLIGHT and asks for the passenger-composition
    // breakdown (a booking-required field) — never budget, which is already excluded from this flow.
    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const result2 = await orchestrator2.complete({
      messages: [{ role: "user", content: "flight book kar do" }],
      tools
    });
    expect(orchestrator2.pendingAction).toBe("BOOK_FLIGHT");
    expect(result2.content).not.toMatch(/budget/i);
    expect(result2.content).toBe(buildPassengerCompositionClarificationMessage(5, "ENGLISH"));

    // 3. Budget aside: an explicit budget question mid-booking is answered, but must not erase the
    // in-progress booking intent.
    const real3 = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(
      real3,
      config,
      orchestrator2.lastEntities,
      orchestrator2.lastMemory
    );
    await orchestrator3.complete({
      messages: [{ role: "user", content: "what's the budget looking like" }],
      tools
    });
    expect(orchestrator3.pendingAction).toBe("BOOK_FLIGHT");

    // 4. Passenger conflict: a single-category correction (PATCH) doesn't add up to the previously stated
    // total of 5 — asks for clarification instead of silently guessing, and BOOK_FLIGHT survives untouched.
    const real4 = fakeProvider({ extraction: { adults: 2 }, intent: "provide_trip_details" });
    const orchestrator4 = new TravelEmployeeLlmOrchestrator(
      real4,
      config,
      orchestrator3.lastEntities,
      orchestrator3.lastMemory
    );
    const result4 = await orchestrator4.complete({
      messages: [{ role: "user", content: "2 adults" }],
      tools
    });
    expect(result4.content).toBe(buildPassengerCompositionConflictMessage(5, 2, "ENGLISH"));
    expect(orchestrator4.lastEntities.adults).toBeNull();
    expect(orchestrator4.pendingAction).toBe("BOOK_FLIGHT");

    // 5. Replacement + search resumes: two categories mentioned together is a FULL_REPLACEMENT — it
    // commits immediately (zeroing the unmentioned infants), which completes the booking-required fields
    // and resumes BOOK_FLIGHT into an actual travel.search_flights call in the very same turn.
    const real5 = fakeProvider({ extraction: { adults: 2, children: 3 }, intent: "provide_trip_details" });
    const orchestrator5 = new TravelEmployeeLlmOrchestrator(
      real5,
      config,
      orchestrator4.lastEntities,
      orchestrator4.lastMemory
    );
    const result5 = await orchestrator5.complete({
      messages: [{ role: "user", content: "2 adults 3 kids" }],
      tools
    });
    expect(orchestrator5.lastEntities.adults).toBe(2);
    expect(orchestrator5.lastEntities.children).toBe(3);
    expect(orchestrator5.lastEntities.infants).toBe(0);
    expect(orchestrator5.lastEntities.totalTravellers).toBe(5);
    expect(orchestrator5.pendingPassengerConflict).toBeNull();
    expect(orchestrator5.pendingAction).toBeNull();
    expect(result5.toolCalls[0]?.name).toBe("travel.search_flights");
  });
});

describe("classifyPlanningAction: business-workflow actions (ADD_TRIP_LEG, SUBMIT_ENQUIRY, CREATE_LEAD, REQUEST_CALLBACK)", () => {
  it("classifies ADD_TRIP_LEG, including Hinglish 'X se Y ka plan continue karo' phrasing", () => {
    expect(classifyPlanningAction("London se New York ka plan continue karo")).toBe("ADD_TRIP_LEG");
    expect(classifyPlanningAction("continue to New York")).toBe("ADD_TRIP_LEG");
    expect(classifyPlanningAction("add another leg to Tokyo")).toBe("ADD_TRIP_LEG");
    expect(classifyPlanningAction("then go to Rome")).toBe("ADD_TRIP_LEG");
  });
  it("never classifies unrelated uses of 'continue' as ADD_TRIP_LEG", () => {
    expect(classifyPlanningAction("please continue")).not.toBe("ADD_TRIP_LEG");
    expect(classifyPlanningAction("continue the conversation")).not.toBe("ADD_TRIP_LEG");
  });
  it("classifies SUBMIT_ENQUIRY", () => {
    expect(classifyPlanningAction("submit this request")).toBe("SUBMIT_ENQUIRY");
    expect(classifyPlanningAction("please submit my enquiry")).toBe("SUBMIT_ENQUIRY");
  });
  it("classifies CREATE_LEAD", () => {
    expect(classifyPlanningAction("generate lead")).toBe("CREATE_LEAD");
    expect(classifyPlanningAction("create a lead")).toBe("CREATE_LEAD");
  });
  it("classifies REQUEST_CALLBACK", () => {
    expect(classifyPlanningAction("call me")).toBe("REQUEST_CALLBACK");
    expect(classifyPlanningAction("please request a callback")).toBe("REQUEST_CALLBACK");
  });
  it("CREATE_LEAD takes priority when a message asks for both a lead and a callback in one breath", () => {
    expect(classifyPlanningAction("generate lead and ask anyone to call")).toBe("CREATE_LEAD");
  });
  it("these four business-workflow actions win over the itinerary/booking patterns", () => {
    expect(classifyPlanningAction("submit this request")).not.toBe("GENERATE_ITINERARY");
    expect(classifyPlanningAction("generate lead")).not.toBe("BOOK_FLIGHT");
  });
});

describe("live-conversation regression: ADD_TRIP_LEG (bug fix: 'continue to <city>' must add a leg, not run a generic search)", () => {
  const delhiToLondon: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Delhi",
    destinationCity: "London",
    travelMonth: "March",
    days: 5,
    adults: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };

  it("'London se New York ka plan continue karo' finalizes the Delhi->London leg and starts a fresh London->New York leg", async () => {
    const real = fakeProvider({
      extraction: { originCity: "London", destinationCity: "New York" },
      intent: "provide_trip_details",
      reply: "Which dates work for New York?"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, delhiToLondon);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "London se New York ka plan continue karo" }],
      tools: [
        { name: "travel.search_flights", description: "", inputSchema: {} },
        { name: "travel.search_hotels", description: "", inputSchema: {} }
      ]
    });
    expect(result.toolCalls).toEqual([]);
    // The message itself is Hinglish ("se", "ka", "karo" markers), so the reply follows suit.
    expect(orchestrator.responseLanguage).toBe("HINGLISH");
    expect(result.content).toContain(buildTripLegAddedMessage("London", "New York", "HINGLISH"));

    expect(orchestrator.journey).not.toBeNull();
    expect(orchestrator.journey?.status).toBe("PLANNING");
    expect(orchestrator.journey?.legs).toHaveLength(1);
    expect(orchestrator.journey?.legs[0]).toMatchObject({
      origin: "Delhi",
      destination: "London",
      dates: { travelMonth: "March", departureDate: null, returnDate: null },
      duration: { days: 5, nights: null },
      budget: { amount: 3000, currency: "USD" }
    });

    // The new leg: origin/destination updated, dates/duration/budget reset, passengers carried over.
    expect(orchestrator.lastEntities.originCity).toBe("London");
    expect(orchestrator.lastEntities.destinationCity).toBe("New York");
    expect(orchestrator.lastEntities.travelMonth).toBeNull();
    expect(orchestrator.lastEntities.days).toBeNull();
    expect(orchestrator.lastEntities.budget).toBeNull();
    expect(orchestrator.lastEntities.adults).toBe(2);
  });

  it("a misclassified intent (start_new_trip) can never wipe the leg being finalized — the pre-merge snapshot wins", async () => {
    const real = fakeProvider({
      extraction: { originCity: "London", destinationCity: "New York" },
      intent: "start_new_trip"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, delhiToLondon);
    await orchestrator.complete({
      messages: [{ role: "user", content: "continue to New York" }]
    });
    expect(orchestrator.journey?.legs).toHaveLength(1);
    expect(orchestrator.journey?.legs[0]?.destination).toBe("London");
  });
});

describe("live-conversation regression: SUBMIT_ENQUIRY / CREATE_LEAD must never execute a travel provider search (bug fix), and never depend on a CRM connector", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Sydney",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };
  const tools = [
    { name: "travel.search_flights", description: "", inputSchema: {} },
    { name: "travel.search_hotels", description: "", inputSchema: {} },
    { name: "travel.create_lead", description: "", inputSchema: {} }
  ];

  it("'submit this request' asks for a phone number, never a search — no CRM connector needed at all", async () => {
    // Intent is deliberately "confirm_plan" — the exact LLM misread that used to trigger an unauthorized search.
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "submit this request" }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(result.content).not.toMatch(/CRM/i);
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
  });

  it("'generate lead' with a phone number already given captures the lead carrying the trip details, never a search", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "generate lead, call me on +919876543210" }],
      tools
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.create_lead");
    const args = result.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(args).toMatchObject({
      phoneNumber: "+919876543210",
      departureCity: "Chennai",
      destination: "Sydney",
      budgetAmount: 3000,
      budgetCurrency: "USD"
    });
  });

  it("returns the Reference Number once the lead-capture tool call actually succeeds", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    await orchestrator.complete({
      messages: [{ role: "user", content: "submit this request, call me on +919876543210" }],
      tools
    });
    const followUp = await orchestrator.complete({
      messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-1", reference: "TRV-ABCDEF" }) }]
    });
    expect(followUp.content).toBe(buildLeadCapturedMessage("Alex", "TRV-ABCDEF", "ENGLISH"));
    expect(followUp.content).toContain("TRV-ABCDEF");
    expect(orchestrator.lastMemory.completionStage).toBe("CAPTURED");
    expect(orchestrator.journey).toBeNull();
  });

  it("falls back to an honest message, never a fabricated reference, when the save fails", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    await orchestrator.complete({
      messages: [{ role: "user", content: "submit this request, call me on +919876543210" }],
      tools
    });
    const followUp = await orchestrator.complete({
      messages: [{ role: "tool", content: JSON.stringify({ success: false }) }]
    });
    expect(followUp.content).not.toContain("Reference Number");
    expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
  });
});

describe("live-conversation regression: REQUEST_CALLBACK (bug fix: must never resolve to just a support-email escalation), and never depend on a CRM connector", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Sydney",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };
  const tools = [{ name: "travel.create_lead", description: "", inputSchema: {} }];

  it("'generate lead and ask anyone to call' with a phone number captures the lead in one turn, never just a support email", async () => {
    // Intent is deliberately "request_human" — the exact LLM misread that used to return only a support email.
    const real = fakeProvider({ extraction: {}, intent: "request_human" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "generate lead and ask anyone to call me, my number is +919876543210" }],
      tools
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("travel.create_lead");
    expect(result.content).not.toMatch(/support@|escalationContact|human team member/i);

    const followUp = await orchestrator.complete({
      messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-2", reference: "TRV-CALL01" }) }]
    });
    expect(followUp.content).not.toMatch(/support@|escalationContact|human team member/i);
    expect(followUp.content).toContain("TRV-CALL01");
  });

  it("'call me' alone, with no phone number yet, transitions into lead capture and politely asks for one", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "call me" }],
      tools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
  });

  it("'call me' with a lead already captured this conversation re-confirms it instead of asking again", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      completionStage: "CAPTURED",
      capturedLeadReference: "TRV-EXIST1"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "call me" }] });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildLeadAlreadyCapturedMessage("TRV-EXIST1", "ENGLISH"));
  });
});

describe("live-conversation regression: full journey — Delhi->London -> London->New York -> submit -> lead capture (bug fix)", () => {
  it("Delhi->London, then London->New York, then submit request with a phone number, then lead captured — no travel provider search anywhere, never a CRM dependency", async () => {
    const delhiToLondon: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "London",
      travelMonth: "March",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} },
      { name: "travel.create_lead", description: "", inputSchema: {} }
    ];
    const allToolCalls: string[] = [];

    // 1. London -> New York: ADD_TRIP_LEG finalizes the Delhi->London leg.
    const real1 = fakeProvider({
      extraction: { originCity: "London", destinationCity: "New York" },
      intent: "provide_trip_details"
    });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, delhiToLondon);
    const result1 = await orchestrator1.complete({
      messages: [{ role: "user", content: "London se New York ka plan continue karo" }],
      tools
    });
    allToolCalls.push(...result1.toolCalls.map((call) => call.name));
    expect(orchestrator1.journey?.status).toBe("PLANNING");
    expect(orchestrator1.journey?.legs).toHaveLength(1);

    // 2. Fill in the New York leg's own dates/duration/budget.
    const real2 = fakeProvider({
      extraction: { travelMonth: "April", days: 4, budget: 2000, budgetCurrency: "USD" },
      intent: "provide_trip_details"
    });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    const result2 = await orchestrator2.complete({
      messages: [{ role: "user", content: "April mein 4 din ke liye, budget 2000 USD" }],
      tools
    });
    allToolCalls.push(...result2.toolCalls.map((call) => call.name));

    // 3. Submit request with a phone number already given: both legs summarized, one lead, no search.
    const real3 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    const result3 = await orchestrator3.complete({
      messages: [{ role: "user", content: "submit this request, call me on +919876543210" }],
      tools
    });
    allToolCalls.push(...result3.toolCalls.map((call) => call.name));
    expect(result3.toolCalls[0]?.name).toBe("travel.create_lead");
    const submitArgs = result3.toolCalls[0]?.arguments as {
      destination: string;
      conversationSummary: string;
      journeyId: string | null;
    };
    // required test #10: the COMPLETE route, including the very first origin — never just the active leg.
    expect(submitArgs.destination).toBe("Delhi -> London -> New York");
    expect(submitArgs.conversationSummary).toContain("Delhi -> London");
    expect(submitArgs.conversationSummary).toContain("London -> New York");
    expect(submitArgs.journeyId).toBe(orchestrator3.journey?.id);
    expect(submitArgs.journeyId).not.toBeNull();

    // 4. Lead captured: the tool response resolves within the SAME orchestrator instance/execution.
    const result4 = await orchestrator3.complete({
      messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-42", reference: "TRV-DELHI1" }) }]
    });
    allToolCalls.push(...result4.toolCalls.map((call) => call.name));
    expect(result4.content).toContain("TRV-DELHI1");
    expect(orchestrator3.journey?.status).toBe("ENQUIRY_SUBMITTED");
    expect(orchestrator3.lastMemory.completionStage).toBe("CAPTURED");

    // No travel provider search anywhere across the entire regression.
    expect(allToolCalls).not.toContain("travel.search_flights");
    expect(allToolCalls).not.toContain("travel.search_hotels");
  });
});

describe("classifyPlanningAction: complete trip plan, live search, and recommendation actions", () => {
  it("classifies GENERATE_COMPLETE_TRIP_PLAN, never as only GENERATE_ITINERARY", () => {
    expect(classifyPlanningAction("complete end to end plan bna ke do including optimized per day plan")).toBe(
      "GENERATE_COMPLETE_TRIP_PLAN"
    );
    expect(classifyPlanningAction("full trip plan please")).toBe("GENERATE_COMPLETE_TRIP_PLAN");
    expect(classifyPlanningAction("flight hotel itinerary sab batao")).toBe("GENERATE_COMPLETE_TRIP_PLAN");
    expect(classifyPlanningAction("complete package suggest karo")).toBe("GENERATE_COMPLETE_TRIP_PLAN");
    expect(classifyPlanningAction("poora plan bana do")).toBe("GENERATE_COMPLETE_TRIP_PLAN");
    expect(classifyPlanningAction("complete end to end plan bna ke do including optimized per day plan")).not.toBe(
      "GENERATE_ITINERARY"
    );
  });
  it("classifies SEARCH_LIVE_OPTIONS only for explicit live/current phrasing", () => {
    expect(classifyPlanningAction("live options dikhao")).toBe("SEARCH_LIVE_OPTIONS");
    expect(classifyPlanningAction("show me current flight prices")).toBe("SEARCH_LIVE_OPTIONS");
    expect(isExplicitLiveOptionsRequest("live options dikhao")).toBe(true);
    expect(isExplicitLiveOptionsRequest("recommendations bhejo")).toBe(false);
  });
  it("classifies GENERATE_FLIGHT_RECOMMENDATIONS/GENERATE_HOTEL_RECOMMENDATIONS, distinct from SEARCH_FLIGHTS/SEARCH_HOTELS", () => {
    expect(classifyPlanningAction("recommend some flights")).toBe("GENERATE_FLIGHT_RECOMMENDATIONS");
    expect(classifyPlanningAction("recommend hotels")).toBe("GENERATE_HOTEL_RECOMMENDATIONS");
    expect(classifyPlanningAction("suggest hotels near Marina")).toBe("GENERATE_HOTEL_RECOMMENDATIONS");
    expect(classifyPlanningAction("tum mujhe recommendations bhejo")).toBe("GENERATE_FLIGHT_RECOMMENDATIONS");
    expect(classifyPlanningAction("show me flight options")).toBe("SEARCH_FLIGHTS");
  });
  it("classifies BOOK_HOTEL, mirroring BOOK_FLIGHT", () => {
    expect(classifyPlanningAction("book the hotel")).toBe("BOOK_HOTEL");
    expect(classifyPlanningAction("hotel book kar do")).toBe("BOOK_HOTEL");
  });
});

describe("live-conversation regression: GENERATE_COMPLETE_TRIP_PLAN (bug fix: 'complete end to end plan' must return everything, not just an itinerary)", () => {
  it("'complete end to end plan bna ke do including optimized per day plan' returns flights + hotels + budget + itinerary", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "New Delhi",
      destinationCity: "Bali",
      travelMonth: "December",
      days: 6,
      adults: 2,
      children: 1,
      infants: 1,
      budget: 4000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n14:00 Arrival and check-in\n15:30 Rest/nap break\n18:00 Dinner"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "bhai complete end to end plan bna ke do including optimized per day plan" }]
    });
    expect(result.toolCalls).toEqual([]);
    // The message itself is Hinglish ("bhai", "bna", "ke" markers), so the reply follows suit.
    expect(orchestrator.responseLanguage).toBe("HINGLISH");
    expect(result.content).toMatch(/trip details noted/i);
    expect(result.content).not.toMatch(/confirmed trip/i);
    expect(result.content).toMatch(/flight/i);
    expect(result.content).toMatch(/airport|route|land karte/i);
    expect(result.content).toMatch(/hotel/i);
    expect(result.content).toMatch(/room/i);
    expect(result.content).toMatch(/estimated budget.*category-wise/i);
    expect(result.content).toContain("Day 1");
    expect(result.content).toMatch(/getting around/i);
    expect(result.content).toMatch(/visa/i);
    expect(result.content).toMatch(/insurance/i);
    expect(result.content).toMatch(/next:/i);
    expect(result.content).toMatch(/indicative recommendations hain, live availability nahi/i);
    // Personalization preserved.
    expect(result.content).toContain("New Delhi");
    expect(result.content).toContain("Bali");
    expect(result.content).toMatch(/infant/i);
  });

  it("asks for the one missing required field instead of generating a partial plan", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", adults: 2 };
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Where would you like to go?" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "poora plan bana do" }] });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).not.toMatch(/confirmed trip/i);
  });

  it("threads passenger composition and infant pacing into the itinerary generation, and preserves them in the room/occupancy section", async () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Mumbai",
      destinationCity: "Kerala",
      travelMonth: "November",
      days: 4,
      adults: 2,
      children: 1,
      infants: 1,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "poora plan bana do" }] });
    const itineraryPrompt = real.calls[1]?.messages[0]?.content ?? "";
    expect(itineraryPrompt).toContain("2 adults, 1 child and 1 infant");
    expect(itineraryPrompt).toMatch(/slower pace|rest\/nap/i);
    expect(result.content).toContain("2 adults, 1 child and 1 infant");
    expect(result.content).toMatch(/infant/i);
  });
});

describe("live-conversation regression: provider-independent indicative recommendations (bug fix: 'recommendations bhejo' must never re-execute a live search)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Bangkok",
    travelMonth: "March",
    days: 5,
    adults: 2,
    budget: 1500,
    budgetCurrency: "USD"
  };

  it("GENERATE_FLIGHT_RECOMMENDATIONS produces indicative content even with zero tools configured", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "tum mujhe recommendations bhejo" }] });
    expect(result.toolCalls).toEqual([]);
    // "tum"/"mujhe" are Hinglish markers, so the reply follows suit.
    expect(orchestrator.responseLanguage).toBe("HINGLISH");
    expect(result.content).toMatch(/indicative recommendations hain, live availability nahi/i);
    expect(result.content).toMatch(/flight/i);
    expect(result.content).toMatch(/hotel/i);
  });

  it("never claims a live price, availability, flight number, or hotel inventory — only the aggregate budget estimate and qualitative guidance", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Rome",
      originCity: "Milan",
      days: 4,
      travelMonth: "June",
      adults: 2,
      budgetCurrency: "USD"
    };
    const estimate = estimateBudgetRange(trip, config);
    const message = buildIndicativeRecommendationsMessage(trip, estimate, "ENGLISH", false);
    expect(message).toContain("These are indicative recommendations, not live availability.");
    expect(message).not.toMatch(/SkyLink|GlobalWing|Northern Star/i);
    expect(message).not.toMatch(/Harbor View|Central Plaza|Palm Court/i);
  });

  it("Stage 9F/G UAT fix: buildHotelRecommendationsMessage returns hotel-only content — no flights, no airport guidance, no budget-feasibility note", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Dubai",
      originCity: "Delhi",
      days: 5,
      travelMonth: "September",
      adults: 2,
      budget: 10000,
      budgetCurrency: "AED"
    };
    const estimate = estimateBudgetRange(trip, config);
    const message = buildHotelRecommendationsMessage(trip, estimate, "ENGLISH");
    expect(message).toContain("These are indicative recommendations, not live availability.");
    expect(message).toContain("Dubai");
    expect(message).toMatch(/Indicative hotel range/i);
    expect(message).not.toMatch(/flight/i);
    expect(message).not.toMatch(/airport/i);
    expect(message).not.toMatch(/budget feasibility/i);
    expect(message).not.toMatch(/below minimum/i);
  });

  it("Stage 9G UAT fix: extractHotelArea resolves 'near Marina' for Dubai to 'Dubai Marina'", () => {
    expect(extractHotelArea("suggest hotels near Marina", "Dubai")).toBe("Dubai Marina");
    expect(extractHotelArea("hotels in Dubai Marina", "Dubai")).toBe("Dubai Marina");
    expect(extractHotelArea("stay near Marina", "Dubai")).toBe("Dubai Marina");
    expect(extractHotelArea("near Marina please", "Dubai")).toBe("Dubai Marina");
  });

  it("Stage 9G UAT fix: extractHotelArea resolves JBR for Dubai", () => {
    expect(extractHotelArea("hotels around JBR", "Dubai")).toBe("Jumeirah Beach Residence (JBR)");
    expect(extractHotelArea("hotel near JBR", "Dubai")).toBe("Jumeirah Beach Residence (JBR)");
  });

  it("Stage 9G UAT fix: extractHotelArea resolves Downtown for Dubai", () => {
    expect(extractHotelArea("hotel near Downtown", "Dubai")).toBe("Downtown Dubai");
  });

  it("Stage 9G UAT fix: extractHotelArea returns null when no area mentioned", () => {
    expect(extractHotelArea("suggest hotels", "Dubai")).toBeNull();
    expect(extractHotelArea("recommend hotels", "Dubai")).toBeNull();
    expect(extractHotelArea("suggest hotels near Marina", null)).toBeNull();
    expect(extractHotelArea("", "Dubai")).toBeNull();
  });

  it("Stage 9G UAT fix: buildRequestedAreaGuidance includes the requested area name and destination", () => {
    const guidance = buildRequestedAreaGuidance("Dubai", "Dubai Marina", "ENGLISH");
    expect(guidance).toContain("Dubai Marina");
    expect(guidance).toContain("Dubai");
    expect(guidance).toContain("recommended area");
  });

  it("Stage 9G UAT fix: buildHotelRecommendationsMessage with 'Dubai Marina' returns area-focused guidance — no generic areas, no flights, no below-minimum", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Dubai",
      originCity: "Delhi",
      days: 5,
      travelMonth: "September",
      adults: 2,
      budget: 10000,
      budgetCurrency: "AED"
    };
    const estimate = estimateBudgetRange(trip, config);
    const message = buildHotelRecommendationsMessage(trip, estimate, "ENGLISH", "Dubai Marina");
    expect(message).toContain("Dubai Marina");
    expect(message).toContain("These are indicative recommendations, not live availability.");
    expect(message).toMatch(/Indicative hotel range/i);
    expect(message).not.toMatch(/Downtown/i);
    expect(message).not.toMatch(/Business Bay/i);
    expect(message).not.toMatch(/Deira/i);
    expect(message).not.toMatch(/\bflight\b/i);
    expect(message).not.toMatch(/\bairport\b/i);
    expect(message).not.toMatch(/below minimum/i);
    expect(message).not.toMatch(/budget feasibility/i);
  });

  it("Stage 9G UAT fix: buildHotelRecommendationsMessage without area still uses generic destination guidance", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Dubai",
      originCity: "Delhi",
      days: 5,
      travelMonth: "September",
      adults: 2,
      budget: 10000,
      budgetCurrency: "AED"
    };
    const estimate = estimateBudgetRange(trip, config);
    const message = buildHotelRecommendationsMessage(trip, estimate, "ENGLISH");
    expect(message).toMatch(/Downtown|Business Bay|Deira/i);
    expect(message).not.toMatch(/\bflight\b/i);
    expect(message).not.toMatch(/\bairport\b/i);
    expect(message).not.toMatch(/below minimum/i);
  });

  it("buildCompleteTripPlanMessage never invents a specific airline/hotel name either, and preserves family/infant requirements", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Rome",
      originCity: "Milan",
      days: 4,
      travelMonth: "June",
      adults: 2,
      children: 1,
      infants: 1,
      budgetCurrency: "USD"
    };
    const estimate = estimateBudgetRange(trip, config);
    const message = buildCompleteTripPlanMessage(trip, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    expect(message).not.toMatch(/SkyLink|GlobalWing|Northern Star/i);
    expect(message).not.toMatch(/Harbor View|Central Plaza|Palm Court/i);
    expect(message).toMatch(/2 adults, 1 child and 1 infant/i);
    expect(message).toContain("Day 1");
  });
});

describe("live-conversation regression: provider-failure memory (bug fix: vague follow-up must not blindly retry a failed live search)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Mumbai",
    destinationCity: "Singapore",
    travelMonth: "May",
    days: 4,
    adults: 2,
    budget: 2500,
    budgetCurrency: "USD"
  };
  const tools = [
    { name: "travel.search_flights", description: "", inputSchema: {} },
    { name: "travel.search_hotels", description: "", inputSchema: {} }
  ];

  it("a failed live search is recorded, and 'recommendations bhejo' afterwards gets indicative content instead of retrying", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real1, config, readyTrip);
    const searchAttempt = await orchestrator.complete({
      messages: [{ role: "user", content: "yes go ahead" }],
      tools
    });
    expect(searchAttempt.toolCalls[0]?.name).toBe("travel.search_flights");

    const failureResult = await orchestrator.complete({
      messages: [
        { role: "tool", content: JSON.stringify({ error: true, errorCode: "TOOL_TIMEOUT", toolName: "travel.search_flights" }) }
      ]
    });
    expect(failureResult.toolCalls).toEqual([]);
    expect(failureResult.content).toMatch(/indicative recommendations, not live availability/i);
    expect(orchestrator.providerFailure).toMatchObject({
      failedAction: "SEARCH_LIVE_OPTIONS",
      provider: "travel.search_flights",
      retryable: true
    });

    const real3 = fakeProvider({ extraction: {}, intent: "ask_recommendation" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator.lastEntities, orchestrator.lastMemory);
    const followUp = await orchestrator3.complete({
      messages: [{ role: "user", content: "recommendations bhejo" }],
      tools
    });
    expect(followUp.toolCalls).toEqual([]);
    expect(followUp.content).toMatch(/indicative recommendations, not live availability/i);
  });

  it("a bare 'yes' after a provider failure also gets indicative recommendations — the gate applies even when the message matches no recommendation phrase", async () => {
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "confirm_plan" }),
      config,
      readyTrip,
      {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        providerFailure: {
          failedAction: "SEARCH_LIVE_OPTIONS",
          provider: "travel.search_flights",
          failedAt: new Date(0).toISOString(),
          retryable: true,
          selectedRecoveryAction: null,
          menuActive: true,
          menuExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        }
      }
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "yes go ahead" }], tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/indicative recommendations, not live availability/i);
  });

  it("explicit 'live options dikhao' overrides the provider-failure gate and retries the live search", async () => {
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      readyTrip,
      {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        providerFailure: {
          failedAction: "SEARCH_LIVE_OPTIONS",
          provider: "travel.search_flights",
          failedAt: new Date(0).toISOString(),
          retryable: true,
          selectedRecoveryAction: null,
          menuActive: true,
          menuExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        }
      }
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "live options dikhao" }], tools });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
    expect(orchestrator.providerFailure).toBeNull();
  });
});

describe("live-conversation regression: date acknowledgement wording (bug fix: recording a date must never say 'flight confirmed')", () => {
  it("a day/month date remains pending and asks only for the year", async () => {
    const real = fakeProvider({ extraction: { departureDate: "2026-03-10" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      adults: 2
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "hum 10 March ko jaayenge" }] });
    expect(real.calls).toHaveLength(1);
    expect(orchestrator.lastMemory.pendingDepartureDate).toMatchObject({ day: 10, month: 3, year: null });
    expect(orchestrator.lastEntities.departureDate).toBeNull();
  });
});

describe("live-conversation regression: provider failure must never intercept an explicit, unrelated planning action (bug fix)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Bangkok",
    travelMonth: "March",
    days: 5,
    adults: 2,
    budget: 1500,
    budgetCurrency: "USD"
  };
  const failedMemory = {
    ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
    providerFailure: {
      failedAction: "SEARCH_LIVE_OPTIONS" as const,
      provider: "travel.search_flights",
      failedAt: new Date(0).toISOString(),
      retryable: true,
      selectedRecoveryAction: null,
      menuActive: true,
      menuExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    }
  };
  const tools = [
    { name: "travel.search_flights", description: "", inputSchema: {} },
    { name: "travel.search_hotels", description: "", inputSchema: {} },
    { name: "travel.crm.create_lead", description: "", inputSchema: {} },
    { name: "travel.crm.update_lead", description: "", inputSchema: {} }
  ];

  it("search failure -> day itinerary -> returns the itinerary immediately, not the provider recommendations", async () => {
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "mujhe day by day trip plan schedule batao" }],
      tools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain("Day 1");
    expect(result.content).not.toMatch(/indicative recommendations/i);
    expect(result.content).not.toMatch(/retry the live search/i);
    // The failure record itself is untouched — it neither blocks nor is consumed by an unrelated action.
    expect(orchestrator.providerFailure).not.toBeNull();
  });

  it("search failure -> complete trip plan -> returns the full complete plan, not the provider recommendations", async () => {
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "complete end to end plan please" }],
      tools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/trip details noted/i);
    expect(result.content).not.toMatch(/confirmed trip/i);
    expect(result.content).toContain("Day 1");
    expect(result.content).toMatch(/packing/i);
    expect(result.content).toMatch(/tips/i);
  });

  it("search failure -> attractions -> returns attractions, not the provider recommendations", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question", reply: "There's great sightseeing near the old town." });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "kaha ghumna chahiye" }],
      tools
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).not.toMatch(/indicative recommendations/i);
    expect(result.content).toContain("sightseeing");
  });

  // Real UAT bug: accepting the indicative numbers used to just acknowledge ("Anything else you'd like to
  // adjust?") and dead-end there, requiring a separate explicit "book my flight" before ever seeing
  // bookable options. Accepting IS the traveler saying "let's move forward" — this must go straight to the
  // same structured, selectable Option 1/2/3 packages an explicit booking request would show.
  it("search failure -> '1' -> goes straight to structured Option 1/2/3 packages (every required field is already known) — never the old dead-end acknowledgement", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "1" }], tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toMatch(/Option 1 — Value/);
    expect(result.content).toMatch(/Option 2 — Recommended/);
    expect(result.content).toMatch(/Option 3 — Premium/);
    expect(result.content).not.toBe(buildRecoveryContinuationMessage("ENGLISH"));
    expect(orchestrator.lastMemory.pendingAction).toBe("AWAITING_OPTION_SELECTION");
    expect(orchestrator.lastMemory.pendingRecommendations).toHaveLength(3);
    expect(orchestrator.providerFailure?.selectedRecoveryAction).toBe("INDICATIVE_RECOMMENDATIONS");
  });

  it("search failure -> '1' -> falls back to the plain acknowledgement (never fabricated packages) when a required field is still genuinely missing", async () => {
    const incompleteTrip: TravelEntities = { ...readyTrip, budget: null, budgetCurrency: null };
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, incompleteTrip, failedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "1" }], tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildRecoveryContinuationMessage("ENGLISH"));
    expect(result.content).not.toMatch(/\(1\)|\(2\)|\(3\)/);
    expect(orchestrator.providerFailure?.selectedRecoveryAction).toBe("INDICATIVE_RECOMMENDATIONS");
  });

  it("search failure -> '2' -> retries the live provider and clears the failure record", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "2" }], tools });
    expect(result.toolCalls[0]?.name).toBe("travel.search_flights");
    expect(orchestrator.providerFailure).toBeNull();
  });

  it("search failure -> '3' -> moves into lead capture (asks for a phone number)", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, failedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "3" }], tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
    expect(orchestrator.providerFailure?.selectedRecoveryAction).toBe("CALLBACK");
  });
});

describe("detectProviderFailureRecoverySelection (parser)", () => {
  it("recognizes bare digits and 'option N' phrasing", () => {
    expect(detectProviderFailureRecoverySelection("1")).toBe("INDICATIVE_RECOMMENDATIONS");
    expect(detectProviderFailureRecoverySelection("option 2")).toBe("RETRY_LIVE_SEARCH");
    expect(detectProviderFailureRecoverySelection("3")).toBe("CALLBACK");
  });
  it("never misfires on an unrelated message that merely contains a number", () => {
    expect(detectProviderFailureRecoverySelection("2 adults")).toBeNull();
    expect(detectProviderFailureRecoverySelection("we are 3 travellers")).toBeNull();
  });
});

describe("parseJourneyLegChain (parser: multiple legs from one free-text message)", () => {
  it("parses two legs from one utterance, chaining the shared city instead of double-counting it", () => {
    const legs = parseJourneyLegChain("Washington se London aur fir London se Delhi ye bhi include kro");
    expect(legs).toEqual([
      { origin: "Washington", destination: "London", days: null, nights: null },
      { origin: "London", destination: "Delhi", days: null, nights: null }
    ]);
  });

  it("binds a stay duration to the correct destination leg, leaving the return leg with no stay", () => {
    const legs = parseJourneyLegChain(
      "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai"
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({ origin: "Washington", destination: "London", days: 3, nights: null });
    expect(legs[1]).toEqual({ origin: "London", destination: "Delhi", days: null, nights: null });
  });

  it("understands the equivalent English word order", () => {
    const legs = parseJourneyLegChain("Washington to London and then London to Delhi, 3 nights in London");
    expect(legs[0]).toEqual({ origin: "Washington", destination: "London", days: null, nights: 3 });
    expect(legs[1]).toEqual({ origin: "London", destination: "Delhi", days: null, nights: null });
  });

  it("returns a single leg (or none) when the message describes only one destination change", () => {
    expect(parseJourneyLegChain("continue to New York")).toEqual([]);
    expect(parseJourneyLegChain("London se New York ka plan continue karo")).toEqual([
      { origin: "London", destination: "New York", days: null, nights: null }
    ]);
  });
});

describe("estimateJourneyBudgetRange (journey-level aggregation across legs)", () => {
  const travellerProfile: JourneyTravellerProfile = {
    originCity: "Delhi",
    cabinClass: null,
    hotelStars: null,
    preferences: []
  };
  function makeLeg(
    origin: string,
    destination: string,
    days: number | null,
    nights: number | null,
    sequence: number
  ) {
    return toJourneyLeg(
      {
        ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
        originCity: origin,
        destinationCity: destination,
        days,
        nights,
        adults: 2,
        children: 1
      },
      null,
      null,
      sequence
    );
  }
  const threeLegJourney = [
    makeLeg("Delhi", "Washington", 5, null, 1),
    makeLeg("Washington", "London", 3, null, 2),
    makeLeg("London", "Delhi", null, null, 3)
  ];

  it("sums Flights/Hotel/Food/Local transport/Activities across every leg; a no-stay leg still costs flights but zero lodging", () => {
    const result = estimateJourneyBudgetRange(threeLegJourney, travellerProfile, config);
    expect(result.perLeg).toHaveLength(3);
    const returnLegEstimate = result.perLeg[2]?.estimate;
    expect(returnLegEstimate?.breakdown.find((line) => line.label === "Hotel")).toMatchObject({ low: 0, high: 0 });
    expect(returnLegEstimate?.breakdown.find((line) => line.label === "Food")).toMatchObject({ low: 0, high: 0 });
    expect(returnLegEstimate?.breakdown.find((line) => line.label === "Flights")?.low).toBeGreaterThan(0);

    const combinedFlights = result.combined.breakdown.find((line) => line.label === "Flights");
    const perLegFlightsSum = result.perLeg.reduce(
      (sum, entry) => sum + (entry.estimate.breakdown.find((line) => line.label === "Flights")?.low ?? 0),
      0
    );
    expect(combinedFlights?.low).toBe(perLegFlightsSum);
  });

  it("charges visa once per unique non-home destination, excluding the traveler's home city", () => {
    const result = estimateJourneyBudgetRange(threeLegJourney, travellerProfile, config);
    const singleLegVisa = result.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Visa");
    const combinedVisa = result.combined.breakdown.find((line) => line.label === "Visa");
    // Chargeable destinations: Washington, London (Delhi is home — excluded) -> exactly 2x a single leg's figure.
    expect(combinedVisa?.low).toBe((singleLegVisa?.low ?? 0) * 2);
    expect(combinedVisa?.high).toBe((singleLegVisa?.high ?? 0) * 2);
  });

  it("never double-counts visa when the SAME destination appears in more than one leg", () => {
    const legs = [
      makeLeg("Delhi", "London", 3, null, 1),
      makeLeg("London", "Paris", 2, null, 2),
      makeLeg("Paris", "London", 2, null, 3)
    ];
    const result = estimateJourneyBudgetRange(legs, travellerProfile, config);
    const singleLegVisa = result.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Visa");
    const combinedVisa = result.combined.breakdown.find((line) => line.label === "Visa");
    // Unique non-home destinations: London, Paris -> exactly 2x, never 3x despite London appearing twice.
    expect(combinedVisa?.low).toBe((singleLegVisa?.low ?? 0) * 2);
  });

  it("computes insurance once at the journey level, never summed per leg", () => {
    const result = estimateJourneyBudgetRange(threeLegJourney, travellerProfile, config);
    const singleLegInsurance = result.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Insurance");
    const combinedInsurance = result.combined.breakdown.find((line) => line.label === "Insurance");
    expect(combinedInsurance).toEqual(singleLegInsurance);
  });

  it("computes contingency from the aggregated subtotal, never summed from per-leg contingencies", () => {
    const result = estimateJourneyBudgetRange(threeLegJourney, travellerProfile, config);
    const contingency = result.combined.breakdown.find((line) => line.label === "Contingency");
    const subtotalLow = result.combined.breakdown
      .filter((line) => line.label !== "Contingency")
      .reduce((sum, line) => sum + line.low, 0);
    expect(contingency?.low).toBe(Math.round(subtotalLow * 0.05));
    // No per-leg estimate carries its own Contingency line — it is only ever computed once, at the top.
    expect(result.perLeg.every((entry) => !entry.estimate.breakdown.some((line) => line.label === "Contingency"))).toBe(
      true
    );
  });

  it("day/night hotel-cost consistency: 5 days (implying 4 nights) costs exactly the same as an explicit 4 nights", () => {
    const legWithDaysOnly = makeLeg("Delhi", "Washington", 5, null, 1);
    const legWithNightsOnly = makeLeg("Delhi", "Washington", null, 4, 1);
    const resultDays = estimateJourneyBudgetRange([legWithDaysOnly], travellerProfile, config);
    const resultNights = estimateJourneyBudgetRange([legWithNightsOnly], travellerProfile, config);
    expect(resultDays.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Hotel")).toEqual(
      resultNights.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Hotel")
    );
  });
});

describe("live-conversation regression: multi-leg journey estimation (bug fix: new legs must be parsed, persisted, and aggregated)", () => {
  it("Delhi->Washington, then Washington->London->Delhi (London stay 3 days), then 'you suggest the budget' returns a combined 3-leg journey estimate", async () => {
    const delhiToWashington: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Washington",
      days: 5,
      adults: 2,
      children: 1
    };

    // Washington -> London -> Delhi, described in one message, with a stay bound to London only.
    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, delhiToWashington);
    const result2 = await orchestrator2.complete({
      messages: [
        {
          role: "user",
          content: "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai"
        }
      ]
    });
    expect(result2.toolCalls).toEqual([]);

    // Journey has 3 ordered legs — both new legs are persisted alongside the original one.
    const legs = orchestrator2.journey?.legs ?? [];
    expect(legs).toHaveLength(3);
    expect(legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual([
      "Delhi->Washington",
      "Washington->London",
      "London->Delhi"
    ]);
    expect(legs.map((leg) => leg.sequence)).toEqual([1, 2, 3]);
    expect(legs[1]).toMatchObject({ origin: "Washington", destination: "London", duration: { days: 3, nights: null } });
    expect(legs[2]).toMatchObject({ origin: "London", destination: "Delhi", duration: { days: null, nights: null } });

    // "you suggest the budget" — a multi-leg journey now exists, so this must estimate the WHOLE journey.
    const real3 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    const result3 = await orchestrator3.complete({ messages: [{ role: "user", content: "you suggest the budget" }] });
    expect(result3.toolCalls).toEqual([]);
    expect(result3.content).toMatch(/journey summary/i);
    expect(result3.content).toContain("Delhi -> Washington");
    expect(result3.content).toContain("Washington -> London");
    expect(result3.content).toContain("London -> Delhi");
    expect(result3.content).toMatch(/total \(combined\)/i);
    // The earlier turn was Hinglish ("se", "aur fir", "kro" markers), so the sticky language carries through.
    expect(orchestrator3.responseLanguage).toBe("HINGLISH");
    expect(result3.content).toMatch(/indicative recommendations hain, live availability nahi/i);

    // Structural verification: Washington and London (the two stay destinations) both contribute hotel
    // nights; the Delhi return leg does not. All 3 flight sectors are included.
    expect(orchestrator3.journey).not.toBeNull();
    const finalJourney = orchestrator3.journey;
    if (!finalJourney) throw new Error("expected journey to exist");
    const journeyEstimate = estimateJourneyBudgetRange(finalJourney.legs, finalJourney.travellerProfile, config);
    expect(journeyEstimate.perLeg).toHaveLength(3);
    expect(journeyEstimate.perLeg[0]?.estimate.breakdown.find((line) => line.label === "Hotel")?.low).toBeGreaterThan(0);
    expect(journeyEstimate.perLeg[1]?.estimate.breakdown.find((line) => line.label === "Hotel")?.low).toBeGreaterThan(0);
    expect(journeyEstimate.perLeg[2]?.estimate.breakdown.find((line) => line.label === "Hotel")?.low).toBe(0);
    expect(
      journeyEstimate.perLeg.every((entry) => (entry.estimate.breakdown.find((line) => line.label === "Flights")?.low ?? 0) > 0)
    ).toBe(true);

    // It never repeats ONLY the original Delhi->Washington single-leg budget.
    expect(result3.content).not.toBe(buildBudgetGuidanceMessage(delhiToWashington, config, "ENGLISH"));
  });
});

describe("Sprint 4.2 hardening: budget correctness (per-traveller vs total, child/infant factors, reconciliation)", () => {
  const twoAdultsOneChild: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Delhi",
    destinationCity: "Bangkok",
    days: 4,
    adults: 2,
    children: 1
  };

  it("Flights/Visa/Insurance lines carry a perTraveller figure that, times the fare-paying headcount, equals the total", () => {
    const estimate = estimateBudgetRange(twoAdultsOneChild, config);
    const farePayers = 3; // 2 adults + 1 child, per resolveFarePayers' documented full-fare-equivalent policy
    for (const label of ["Flights", "Visa", "Insurance"]) {
      const line = estimate.breakdown.find((entry) => entry.label === label);
      expect(line?.perTraveller).toBeDefined();
      expect((line?.perTraveller?.low ?? 0) * farePayers).toBeCloseTo(line?.low ?? 0, 5);
      expect((line?.perTraveller?.high ?? 0) * farePayers).toBeCloseTo(line?.high ?? 0, 5);
    }
  });

  it("Hotel carries both a perNight and a perRoom figure, and perRoom * rooms reconstructs the total", () => {
    const estimate = estimateBudgetRange(twoAdultsOneChild, config);
    const hotel = estimate.breakdown.find((entry) => entry.label === "Hotel");
    expect(hotel?.perNight).toBeDefined();
    expect(hotel?.perRoom).toBeDefined();
    const rooms = Math.ceil((twoAdultsOneChild.adults ?? 1) / 2);
    expect((hotel?.perRoom?.low ?? 0) * rooms).toBe(hotel?.low);
    expect((hotel?.perRoom?.high ?? 0) * rooms).toBe(hotel?.high);
  });

  it("describeTravellerCostBreakdown reports adult/child/infant counts only — no numeric pricing factor — and the note names both children and infants when present", () => {
    const breakdown = describeTravellerCostBreakdown({ adults: 2, children: 1, infants: 1, totalTravellers: null });
    expect(breakdown.adults).toEqual({ count: 2 });
    expect(breakdown.children).toEqual({ count: 1 });
    expect(breakdown.infants).toEqual({ count: 1 });
    const note = buildTravellerCostFactorNote(breakdown, "ENGLISH");
    expect(note).toMatch(/child/i);
    expect(note).toMatch(/infant/i);
  });

  it("returns no traveller cost-factor note when there are no children or infants", () => {
    const breakdown = describeTravellerCostBreakdown({ adults: 2, children: null, infants: null, totalTravellers: null });
    expect(buildTravellerCostFactorNote(breakdown, "ENGLISH")).toBeNull();
  });

  it("Pricing consistency (Sprint 4.2, option B): the traveller-factor note never states a numeric percentage/formula, and reconciles exactly with how the headline total treats children/infants", () => {
    const twoAdultsOneChildOneInfant: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Bangkok",
      days: 4,
      adults: 2,
      children: 1,
      infants: 1
    };
    const breakdown = describeTravellerCostBreakdown(twoAdultsOneChildOneInfant);
    const note = buildTravellerCostFactorNote(breakdown, "ENGLISH");
    // No numeric formula may be shown at all — the earlier "children ~75%, infants ~10%" wording was a
    // reconciliation bug: it implied a discount the headline total never actually applied.
    expect(note).not.toMatch(/\d/);
    expect(note).toMatch(/full adult fare/i);
    expect(note).toMatch(/does not add infant airfare/i);

    // The displayed breakdown's own counts, combined exactly as `resolveFarePayers` combines them (adults +
    // children, full fare each; infants excluded), must reconstruct the SAME fare-paying headcount that the
    // headline Flights total was actually divided by (its own `perTraveller` figure) — i.e. the passenger
    // breakdown shown to the user and the headline total are proven to share one calculation model.
    const estimate = estimateBudgetRange(twoAdultsOneChildOneInfant, config);
    const flights = estimate.breakdown.find((line) => line.label === "Flights");
    const impliedFarePayers = Math.round((flights?.low ?? 0) / (flights?.perTraveller?.low ?? 1));
    expect(impliedFarePayers).toBe(breakdown.adults.count + breakdown.children.count);
    // Infants are never implicitly counted as fare payers in either the note or the total.
    expect(impliedFarePayers).not.toBe(breakdown.adults.count + breakdown.children.count + breakdown.infants.count);
  });

  it("reconcileBudgetEstimate reports no violations for a live-computed single estimate", () => {
    const estimate = estimateBudgetRange(twoAdultsOneChild, config);
    expect(reconcileBudgetEstimate(estimate)).toEqual([]);
  });

  it("reconcileBudgetEstimate flags a mismatch when the total is tampered with", () => {
    const estimate = estimateBudgetRange(twoAdultsOneChild, config);
    const tampered = { ...estimate, low: estimate.low + 1000 };
    const violations = reconcileBudgetEstimate(tampered);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ scope: "SINGLE_ESTIMATE", actualLow: estimate.low + 1000 });
  });

  it("reconcileJourneyBudgetEstimate reports no violations for a live-computed 3-leg journey (combined total, every per-leg total, and every summed category)", () => {
    const travellerProfile: JourneyTravellerProfile = { originCity: "Delhi", cabinClass: null, hotelStars: null, preferences: [] };
    const legs = [
      toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Washington", days: 5, adults: 2 }, null, null, 1),
      toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Washington", destinationCity: "London", days: 3, adults: 2 }, null, null, 2),
      toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "London", destinationCity: "Delhi", adults: 2 }, null, null, 3)
    ];
    const journeyEstimate = estimateJourneyBudgetRange(legs, travellerProfile, config);
    expect(reconcileJourneyBudgetEstimate(journeyEstimate)).toEqual([]);
  });

  it("reconcileJourneyBudgetEstimate flags a category mismatch when a per-leg breakdown line is tampered with", () => {
    const travellerProfile: JourneyTravellerProfile = { originCity: "Delhi", cabinClass: null, hotelStars: null, preferences: [] };
    const legs = [
      toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Washington", days: 5, adults: 2 }, null, null, 1),
      toJourneyLeg({ ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Washington", destinationCity: "London", days: 3, adults: 2 }, null, null, 2)
    ];
    const journeyEstimate = estimateJourneyBudgetRange(legs, travellerProfile, config);
    const tamperedCombined = {
      ...journeyEstimate,
      combined: {
        ...journeyEstimate.combined,
        breakdown: journeyEstimate.combined.breakdown.map((line) =>
          line.label === "Flights" ? { ...line, low: line.low + 500 } : line
        )
      }
    };
    const violations = reconcileJourneyBudgetEstimate(tamperedCombined);
    expect(violations.some((violation) => violation.scope === "JOURNEY_CATEGORY" && violation.label === "Flights")).toBe(true);
  });
});

describe("Sprint 4.2 hardening: duration semantics (3 days vs 3 nights, never silently relabeled)", () => {
  it("resolveDurationSource distinguishes explicit days, explicit nights, both stated, and unknown", () => {
    expect(resolveDurationSource({ days: 3, nights: null })).toBe("EXPLICIT_DAYS");
    expect(resolveDurationSource({ days: null, nights: 3 })).toBe("EXPLICIT_NIGHTS");
    expect(resolveDurationSource({ days: 3, nights: 2 })).toBe("BOTH_STATED");
    expect(resolveDurationSource({ days: null, nights: null })).toBe("UNKNOWN");
  });

  it("buildDurationPhrase never mislabels days as nights or vice versa", () => {
    expect(buildDurationPhrase({ days: 3, nights: null }, "ENGLISH")).toBe("3 day(s)");
    expect(buildDurationPhrase({ days: null, nights: 3 }, "ENGLISH")).toBe("3 night(s)");
    expect(buildDurationPhrase({ days: 3, nights: 2 }, "ENGLISH")).toBe("3 day(s) / 2 night(s)");
    expect(buildDurationPhrase({ days: null, nights: null }, "ENGLISH")).toBeNull();
  });

  it("states a hotel-costing assumption only when days were stated but nights were not — never when nights are already explicit", () => {
    const fromDaysOnly = buildDurationAssumptionNote({ days: 3, nights: null }, "ENGLISH");
    expect(fromDaysOnly).toMatch(/assumption/i);
    expect(fromDaysOnly).toMatch(/3 day\(s\)/);
    expect(fromDaysOnly).toMatch(/2 night\(s\)/);
    expect(buildDurationAssumptionNote({ days: null, nights: 3 }, "ENGLISH")).toBeNull();
    expect(buildDurationAssumptionNote({ days: null, nights: null }, "ENGLISH")).toBeNull();
  });

  it("hotel cost math itself is identical for '3 days' and '2 nights' (the days-implied night count) — only the disclosed wording differs", () => {
    const withDays: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Goa", adults: 2, days: 3, nights: null };
    const withNights: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Goa", adults: 2, days: null, nights: 2 };
    const estimateDays = estimateBudgetRange(withDays, config);
    const estimateNights = estimateBudgetRange(withNights, config);
    expect(estimateDays.breakdown.find((line) => line.label === "Hotel")).toEqual(
      estimateNights.breakdown.find((line) => line.label === "Hotel")
    );
  });

  it("a complete trip plan's budget section states the days->nights assumption, but never when nights were already explicit", () => {
    const daysOnly: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      travelMonth: "March",
      adults: 2,
      days: 3,
      nights: null
    };
    const estimate = estimateBudgetRange(daysOnly, config);
    const plan = buildCompleteTripPlanMessage(daysOnly, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    expect(plan).toMatch(/assumption: hotel cost is calculated for 2 night\(s\), derived from the 3 day\(s\) stated/i);

    const nightsOnly: TravelEntities = { ...daysOnly, days: null, nights: 3 };
    const estimate2 = estimateBudgetRange(nightsOnly, config);
    const plan2 = buildCompleteTripPlanMessage(nightsOnly, "Day 1\n09:00 Arrival", estimate2, "ENGLISH");
    expect(plan2).not.toMatch(/assumption: hotel cost is calculated for/i);
  });
});

describe("Sprint 4.2 hardening: structured CompleteTripPlan validation", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Delhi",
    destinationCity: "Goa",
    travelMonth: "March",
    adults: 2,
    days: 4
  };

  it("buildCompleteTripPlan emits every required section exactly once", () => {
    const estimate = estimateBudgetRange(readyTrip, config);
    const plan = buildCompleteTripPlan(readyTrip, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    const validation = validateCompleteTripPlan(plan);
    expect(validation).toEqual({ valid: true, missingSections: [], duplicateSections: [] });
  });

  it("validateCompleteTripPlan flags a missing and a duplicated section", () => {
    const estimate = estimateBudgetRange(readyTrip, config);
    const plan = buildCompleteTripPlan(readyTrip, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    const duplicatedSection = plan.sections[1] ?? plan.sections[0];
    if (!duplicatedSection) throw new Error("expected at least one section");
    const tampered = { sections: [...plan.sections.slice(1), duplicatedSection] };
    const validation = validateCompleteTripPlan(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.missingSections).toContain("summary");
    expect(validation.duplicateSections.length).toBeGreaterThan(0);
  });
});

describe("Sprint 4.2 hardening: itinerary validation (arrival/departure-day handling, transit buffers, unknown operating hours)", () => {
  it("the itinerary system prompt instructs a distinct, lighter arrival day and an early, buffered departure day even when no arrival time is known", async () => {
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      travelMonth: "March",
      adults: 2,
      days: 4
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    const generationPrompt = real.calls[real.calls.length - 1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toMatch(/arrival day starts/i);
    expect(generationPrompt).toMatch(/departure day ends early/i);
    expect(generationPrompt).toMatch(/buffer before a flight/i);
    expect(generationPrompt).toMatch(/transit\/rest buffer between distant activities/i);
    expect(generationPrompt).toMatch(/opening hours vary by season/i);
  });

  it("surfaces accessibility, elderly, and infant-pacing guidance in the itinerary prompt when those preferences/passengers are present", async () => {
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      travelMonth: "March",
      adults: 2,
      days: 4,
      infants: 1,
      preferences: ["wheelchair accessible", "senior citizen traveling"]
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    const generationPrompt = real.calls[real.calls.length - 1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toMatch(/infant is traveling/i);
    expect(generationPrompt).toMatch(/wheelchair-friendly/i);
    expect(generationPrompt).toMatch(/senior\/elderly traveler/i);
  });
});

describe("Sprint 4.2 hardening: preferences visibly threaded through the plan (vegetarian, accessibility, child/infant)", () => {
  it("detectTravellerPreferenceFlags recognizes vegetarian/vegan, accessibility, and elderly phrasing", () => {
    expect(detectTravellerPreferenceFlags(["vegetarian food only"])).toEqual({
      vegetarian: true,
      accessibility: false,
      elderly: false
    });
    expect(detectTravellerPreferenceFlags(["wheelchair accessible please"])).toMatchObject({ accessibility: true });
    expect(detectTravellerPreferenceFlags(["traveling with a senior citizen"])).toMatchObject({ elderly: true });
    expect(detectTravellerPreferenceFlags([])).toEqual({ vegetarian: false, accessibility: false, elderly: false });
  });

  it("buildPreferenceApplicationNote names vegetarian dining, accessibility needs, and kid/infant pacing together, and is null when nothing applies", () => {
    const note = buildPreferenceApplicationNote(["vegetarian", "wheelchair accessible"], true, false, "ENGLISH");
    expect(note).toMatch(/vegetarian\/vegan dining/i);
    expect(note).toMatch(/wheelchair\/accessibility needs/i);
    expect(note).toMatch(/kid-friendly pacing/i);
    expect(buildPreferenceApplicationNote([], false, false, "ENGLISH")).toBeNull();
  });

  it("a vegetarian preference produces a visible note in the itinerary prompt AND in the complete trip plan's itinerary section", async () => {
    const vegTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Goa",
      travelMonth: "March",
      adults: 2,
      days: 4,
      preferences: ["vegetarian"]
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, vegTrip);
    await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    const generationPrompt = real.calls[real.calls.length - 1]?.messages[0]?.content ?? "";
    expect(generationPrompt).toMatch(/vegetarian\/vegan — every meal/i);

    const estimate = estimateBudgetRange(vegTrip, config);
    const plan = buildCompleteTripPlanMessage(vegTrip, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    expect(plan).toMatch(/preferences applied:.*vegetarian/i);
  });
});

describe("Sprint 4.2 hardening: provider-failure recovery-menu lifecycle (expiry, invalidation, and the full action-by-action matrix)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Bangkok",
    travelMonth: "March",
    days: 5,
    adults: 2,
    budget: 1500,
    budgetCurrency: "USD"
  };
  const tools = [
    { name: "travel.search_flights", description: "", inputSchema: {} },
    { name: "travel.search_hotels", description: "", inputSchema: {} },
    { name: "travel.crm.create_lead", description: "", inputSchema: {} },
    { name: "travel.crm.update_lead", description: "", inputSchema: {} }
  ];
  function activeFailure() {
    return {
      failedAction: "SEARCH_LIVE_OPTIONS" as const,
      provider: "travel.search_flights",
      failedAt: new Date(0).toISOString(),
      retryable: true,
      selectedRecoveryAction: null,
      menuActive: true,
      menuExpiresAt: new Date(Date.now() + PROVIDER_FAILURE_MENU_TTL_MS).toISOString()
    };
  }

  it("isRecoveryMenuActive is true only while menuActive is set AND the expiry hasn't passed", () => {
    expect(isRecoveryMenuActive(null)).toBe(false);
    expect(isRecoveryMenuActive({ ...activeFailure(), menuActive: false })).toBe(false);
    expect(isRecoveryMenuActive({ ...activeFailure(), menuExpiresAt: new Date(0).toISOString() })).toBe(false);
    expect(isRecoveryMenuActive(activeFailure())).toBe(true);
  });

  it("an EXPIRED recovery menu no longer honors a bare digit as a menu pick — it never retries the live search just because '2' was typed", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      providerFailure: { ...activeFailure(), menuExpiresAt: new Date(0).toISOString() }
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "2" }], tools });
    expect(result.toolCalls.find((call) => call.name === "travel.search_flights")).toBeUndefined();
    // The underlying failure record is untouched by expiry — only the numeric-shortcut window closes.
    expect(orchestrator.providerFailure).not.toBeNull();
  });

  it("a bare digit with NO provider failure on record is never misread as a menu pick", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "2" }], tools });
    expect(result.toolCalls.find((call) => call.name === "travel.search_flights")).toBeUndefined();
    expect(orchestrator.providerFailure).toBeNull();
  });

  it.each([
    ["day itinerary", "day by day itinerary batao", /sightseeing/i],
    ["complete trip plan", "complete end to end plan please", /trip details noted/i],
    ["attractions", "kaha ghumna chahiye", /sightseeing/i],
    ["food recommendations", "kaha khana khayein", /sightseeing/i],
    ["local transport guidance", "wahan ghumne ke liye transport kaisa hai", /sightseeing/i],
    ["budget calculation", "mera budget kitna lagega", /USD/]
  ])(
    "provider failure -> %s -> is answered on its own terms, never blocked by or re-routed into the failed search",
    async (_label, message, expectedPattern) => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question", reply: "There's great sightseeing near the old town, with local food stalls and easy transport links." });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        providerFailure: activeFailure()
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: message }], tools });
      expect(result.toolCalls.find((call) => call.name === "travel.search_flights" || call.name === "travel.search_hotels")).toBeUndefined();
      expect(result.content).toMatch(expectedPattern);
    }
  );
});

describe("Sprint 4.2 hardening: multi-leg scheduling derives tentative next-leg dates, clearly labeled as an assumption", () => {
  it("deriveNextLegDepartureDate adds the prior leg's stay duration (days, or nights+1) to its departure date", () => {
    expect(deriveNextLegDepartureDate({ departureDate: "2026-03-10", days: 5, nights: null })).toEqual({
      departureDate: "2026-03-15",
      isAssumption: true
    });
    expect(deriveNextLegDepartureDate({ departureDate: "2026-03-10", days: null, nights: 4 })).toEqual({
      departureDate: "2026-03-15",
      isAssumption: true
    });
    expect(deriveNextLegDepartureDate({ departureDate: "2026-03-10", days: null, nights: null })).toEqual({
      departureDate: null,
      isAssumption: false
    });
    expect(deriveNextLegDepartureDate({ departureDate: null, days: 5, nights: null })).toEqual({
      departureDate: null,
      isAssumption: false
    });
  });

  it("buildMultiLegAddedMessage labels a derived date as a tentative assumption", () => {
    const message = buildMultiLegAddedMessage(
      [{ origin: "Washington", destination: "London", days: 3, nights: null, departureDate: "2026-03-15", departureDateIsAssumption: true }],
      "ENGLISH"
    );
    expect(message).toMatch(/tentative date 2026-03-15 \(assumption, derived from the previous leg\)/);
  });

  it("adding two legs in one message chains tentative departure dates forward from the first leg's own known departure date", async () => {
    const delhiToWashington: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Washington",
      departureDate: "2026-03-10",
      days: 5,
      adults: 2
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, delhiToWashington);
    const result = await orchestrator.complete({
      messages: [
        {
          role: "user",
          content: "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai"
        }
      ]
    });
    expect(result.toolCalls).toEqual([]);
    // Leg 1 (Washington->London) departs when the Delhi->Washington leg's own 5-day stay ends: 2026-03-15.
    expect(result.content).toContain("tentative date 2026-03-15 (assumption, based on the previous leg)");
    // Leg 2 (London->Delhi) departs when the Washington->London leg's own 3-day stay ends: 2026-03-18.
    expect(result.content).toContain("tentative date 2026-03-18 (assumption, based on the previous leg)");
    const legs = orchestrator.journey?.legs ?? [];
    expect(legs.map((leg) => leg.dates.departureDate)).toEqual(["2026-03-10", "2026-03-15", "2026-03-18"]);
  });
});

describe("Sprint 4.2 hardening: lead-capture idempotency (repeated submit/callback requests)", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
    originCity: "Chennai",
    destinationCity: "Sydney",
    travelMonth: "January",
    days: 5,
    adults: 2,
    budget: 3000,
    budgetCurrency: "USD"
  };
  const tools = [{ name: "travel.create_lead", description: "", inputSchema: {} }];

  it("a repeated 'submit this request' never creates a second lead — it re-confirms the existing reference", async () => {
    const real = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
    const first = await orchestrator.complete({
      messages: [{ role: "user", content: "submit this request, call me on +919876543210" }],
      tools
    });
    expect(first.toolCalls[0]?.name).toBe("travel.create_lead");
    await orchestrator.complete({
      messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-1", reference: "TRV-ABCDEF" }) }]
    });
    expect(orchestrator.lastMemory.completionStage).toBe("CAPTURED");

    const second = await orchestrator.complete({ messages: [{ role: "user", content: "submit this request again" }], tools });
    expect(second.toolCalls).toEqual([]);
    expect(second.content).toBe(buildLeadAlreadyCapturedMessage("TRV-ABCDEF", "ENGLISH"));
  });

  it("a repeated callback request once a lead is already captured just re-confirms it, never asks for a phone number again", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      completionStage: "CAPTURED",
      capturedLeadReference: "TRV-EXIST2"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "call me" }], tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(buildLeadAlreadyCapturedMessage("TRV-EXIST2", "ENGLISH"));
  });
});

describe("Sprint 4.2 hardening: response-language stability across turns", () => {
  it("once Hinglish is detected, it stays sticky across several subsequent English-looking turns", async () => {
    const trip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: "Delhi", destinationCity: "Goa", adults: 2 };
    const real1 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, trip);
    await orchestrator1.complete({ messages: [{ role: "user", content: "hum 4 din ke liye jaana chahte hain bhai" }] });
    expect(orchestrator1.responseLanguage).toBe("HINGLISH");

    const real2 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    await orchestrator2.complete({ messages: [{ role: "user", content: "what about the budget" }] });
    expect(orchestrator2.responseLanguage).toBe("HINGLISH");

    const real3 = fakeProvider({ extraction: {}, intent: "request_plan" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    await orchestrator3.complete({ messages: [{ role: "user", content: "show me the itinerary" }] });
    expect(orchestrator3.responseLanguage).toBe("HINGLISH");
  });
});

describe("Sprint 4.2 hardening: no false confirmation/booking wording anywhere in the complete trip plan", () => {
  it("a complete trip plan for a destination with no 'booked as a package' style hint text never claims anything was confirmed, booked, or reserved", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Paris",
      travelMonth: "March",
      adults: 2,
      days: 4
    };
    const estimate = estimateBudgetRange(trip, config);
    const plan = buildCompleteTripPlanMessage(trip, "Day 1\n09:00 Arrival", estimate, "ENGLISH");
    // "not booked"/"never confirmed"-style disclaimers are exactly the required wording — only an
    // affirmative claim that something IS confirmed/booked/reserved would be a false-confirmation bug.
    expect(plan).not.toMatch(/\bconfirmed trip\b/i);
    expect(plan).not.toMatch(/\b(?:is|was|has been)\s+(?:confirmed|booked|reserved)\b/i);
    expect(plan).not.toMatch(/\bflight\s+(?:is\s+)?booked\b/i);
    expect(plan).toMatch(/trip details noted/i);
    expect(plan).toMatch(/proposed, not booked/i);
  });
});

describe("Sprint 4.2 correctness pass: journey-native complete plans (multi-leg structural validator + exact regression)", () => {
  const travellerProfile: JourneyTravellerProfile = { originCity: "Delhi", cabinClass: null, hotelStars: null, preferences: [] };
  function makeLeg(
    origin: string,
    destination: string,
    departureDate: string,
    days: number | null,
    nights: number | null,
    sequence: number,
    isAssumption = false
  ): JourneyLeg {
    return toJourneyLeg(
      { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", originCity: origin, destinationCity: destination, departureDate, days, nights, adults: 2 },
      null,
      null,
      sequence,
      isAssumption
    );
  }
  const journey: Journey = {
    id: "journey-test",
    travellerProfile,
    status: "PLANNING",
    legs: []
  };
  // The exact regression scenario: Delhi -> Washington (stated date, 5-day stay), then Washington -> London
  // (tentative date derived from leg 1, 3-day stay), then London -> Delhi (tentative date derived from leg
  // 2, immediate/no-stay return).
  const legs: JourneyLeg[] = [
    makeLeg("Delhi", "Washington", "2026-03-10", 5, null, 1, false),
    makeLeg("Washington", "London", "2026-03-15", 3, null, 2, true),
    makeLeg("London", "Delhi", "2026-03-18", null, null, 3, true)
  ];

  it("builds a structurally valid multi-leg complete plan (Delhi -> Washington -> London -> Delhi) with per-leg flights/hotel/occupancy/itinerary/budget, the combined budget, and every derived date labeled as an assumption", () => {
    const journeyEstimate = estimateJourneyBudgetRange(legs, travellerProfile, config);
    const perLegItineraries = legs.map((_, index) => `Day 1\n09:00 Arrival leg ${index + 1}`);
    const plan = buildJourneyCompleteTripPlan(journey, legs, perLegItineraries, journeyEstimate, "ENGLISH");
    const validation = validateJourneyCompleteTripPlan(plan, legs);
    expect(validation).toEqual({ valid: true, missingSections: [], duplicateSections: [] });

    // Every leg gets its own flights/itinerary/budget section exactly once.
    for (const key of ["legFlights", "legItinerary", "legBudget"] as const) {
      expect(plan.sections.filter((section) => section.key === key).map((section) => section.legSequence).sort()).toEqual([
        1, 2, 3
      ]);
    }
    // Only the two stay legs (Washington, London) get hotel/occupancy guidance — the final connecting
    // return leg to Delhi (no stated duration) never fabricates a hotel stay it doesn't have.
    for (const key of ["legHotel", "legOccupancy"] as const) {
      expect(plan.sections.filter((section) => section.key === key).map((section) => section.legSequence).sort()).toEqual([
        1, 2
      ]);
    }
    // Exactly one journey-level section of each required kind.
    for (const key of ["journeySummary", "combinedBudget", "transport", "packing", "tips", "visaInsurance", "disclaimer", "nextSteps"] as const) {
      expect(plan.sections.filter((section) => section.key === key && section.legSequence === null)).toHaveLength(1);
    }

    const rendered = renderJourneyCompleteTripPlan(plan);
    expect(rendered).toContain("Journey summary:");
    expect(rendered).toContain("Delhi -> Washington");
    expect(rendered).toContain("Washington -> London");
    expect(rendered).toContain("London -> Delhi");
    // Leg 1's stated date is shown plainly; legs 2 and 3's derived dates are clearly labeled as assumptions.
    expect(rendered).toContain("departs 2026-03-10");
    expect(rendered).toContain("tentative date 2026-03-15 (assumption, derived from the previous leg)");
    expect(rendered).toContain("tentative date 2026-03-18 (assumption, derived from the previous leg)");
    expect(rendered).toContain("Combined journey budget:");
    expect(rendered).not.toMatch(/\bconfirmed trip\b/i);
    expect(rendered).not.toMatch(/\b(?:is|was|has been)\s+(?:confirmed|booked|reserved)\b/i);
  });

  it("validateJourneyCompleteTripPlan flags a missing leg-scoped section and a duplicated journey-level section", () => {
    const journeyEstimate = estimateJourneyBudgetRange(legs, travellerProfile, config);
    const perLegItineraries = legs.map(() => "Day 1\n09:00 Arrival");
    const plan = buildJourneyCompleteTripPlan(journey, legs, perLegItineraries, journeyEstimate, "ENGLISH");
    const withoutLeg2Budget = plan.sections.filter((section) => !(section.key === "legBudget" && section.legSequence === 2));
    const journeySummarySection = plan.sections.find((section) => section.key === "journeySummary");
    if (!journeySummarySection) throw new Error("expected a journeySummary section");
    const tampered = { sections: [...withoutLeg2Budget, journeySummarySection] };
    const validation = validateJourneyCompleteTripPlan(tampered, legs);
    expect(validation.valid).toBe(false);
    expect(validation.missingSections).toContain("leg 2: legBudget");
    expect(validation.duplicateSections).toContain("journeySummary");
  });

  it("orchestrator integration: Delhi -> Washington -> London -> Delhi, then 'complete end to end plan' returns a journey-native multi-leg plan, never a single-leg render", async () => {
    const delhiToWashington: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Delhi",
      destinationCity: "Washington",
      departureDate: "2026-03-10",
      days: 5,
      adults: 2
    };
    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, delhiToWashington);
    await orchestrator2.complete({
      messages: [
        {
          role: "user",
          content: "Washington se London aur fir London se Delhi ye bhi include kro, London me 3 din ka stay hai"
        }
      ]
    });
    expect(orchestrator2.journey?.legs).toHaveLength(3);

    const real3 = fakeProvider({ extraction: {}, intent: "request_plan", reply: "Day 1\n09:00 Arrival" });
    const orchestrator3 = new TravelEmployeeLlmOrchestrator(real3, config, orchestrator2.lastEntities, orchestrator2.lastMemory);
    const result = await orchestrator3.complete({
      messages: [{ role: "user", content: "complete end to end plan please" }]
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain("Journey summary:");
    expect(result.content).toContain("Delhi -> Washington");
    expect(result.content).toContain("Washington -> London");
    expect(result.content).toContain("London -> Delhi");
    expect(result.content).toContain("Combined journey budget:");
    expect(result.content).toMatch(/tentative date 2026-03-15 \(assumption, based on the previous leg\)/);
    expect(result.content).toMatch(/tentative date 2026-03-18 \(assumption, based on the previous leg\)/);
    expect(result.content).not.toMatch(/\bconfirmed trip\b/i);
    // Never the single-leg render — that path never emits a "Journey summary:" header at all.
    expect(result.content).not.toBe(
      buildCompleteTripPlanMessage(orchestrator3.lastEntities, "Day 1\n09:00 Arrival", estimateBudgetRange(orchestrator3.lastEntities, config), orchestrator3.responseLanguage)
    );

    // Structural validation on the ACTUAL journey the orchestrator produced, not just a hand-built fixture.
    const finalJourney = orchestrator3.journey;
    if (!finalJourney) throw new Error("expected a journey");
    const legs = finalJourney.legs;
    const journeyEstimate = estimateJourneyBudgetRange(legs, finalJourney.travellerProfile, config);
    const plan = buildJourneyCompleteTripPlan(
      finalJourney,
      legs,
      legs.map((leg) => leg.itinerary ?? ""),
      journeyEstimate,
      orchestrator3.responseLanguage
    );
    expect(validateJourneyCompleteTripPlan(plan, legs)).toEqual({ valid: true, missingSections: [], duplicateSections: [] });
  });
});

describe("Sprint 4.2 correctness pass: deterministic itinerary safety validation", () => {
  it("parseItineraryText reads 'Day N' / 'HH:MM Activity' lines, and also the fallback template's 'Din N'/'दिन N' headers", () => {
    expect(parseItineraryText("Day 1\n09:00 Museum\n13:00 Lunch")).toEqual([
      { day: 1, time: "09:00", minutes: 540, activity: "Museum" },
      { day: 1, time: "13:00", minutes: 780, activity: "Lunch" }
    ]);
    expect(parseItineraryText("Din 1\n14:00 Bazaar")).toEqual([{ day: 1, time: "14:00", minutes: 840, activity: "Bazaar" }]);
    expect(parseItineraryText("दिन 1\n14:00 काम")).toEqual([{ day: 1, time: "14:00", minutes: 840, activity: "काम" }]);
  });

  it("passes a well-formed itinerary: increasing times, no duplicate attractions, light arrival day, buffered departure day", () => {
    const text = [
      "Day 1",
      "14:00 Hotel check-in",
      "15:30 Old Town walk",
      "19:00 Dinner",
      "Day 2",
      "09:00 Museum visit",
      "13:00 Lunch",
      "15:00 River cruise",
      "19:00 Dinner",
      "Day 3",
      "09:00 Local market",
      "12:00 Lunch",
      "14:00 Free time"
    ].join("\n");
    const result = validateItineraryText(text, { hasChildren: false, hasInfants: false });
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("flags overlapping/non-increasing time slots", () => {
    const text = "Day 1\n14:00 Museum\n14:00 Gallery\nDay 1\n13:00 Market";
    // Two activities at the exact same time (14:00/14:00) => NON_POSITIVE_DURATION; a later-listed activity
    // (13:00) that sorts BEFORE an earlier one once ordered by time is naturally re-sorted, so overlap here
    // is triggered by the duplicate 14:00 entries specifically.
    const result = validateItineraryText(text, { hasChildren: false, hasInfants: false });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "NON_POSITIVE_DURATION")).toBe(true);
  });

  it("flags a duplicate named attraction across days, but never flags routine repeated meals/rest/check-in", () => {
    const text = [
      "Day 1",
      "14:00 Eiffel Tower",
      "19:00 Dinner",
      "Day 2",
      "09:00 Eiffel Tower",
      "13:00 Lunch",
      "19:00 Dinner"
    ].join("\n");
    const result = validateItineraryText(text, { hasChildren: false, hasInfants: false });
    expect(result.issues.some((issue) => issue.code === "DUPLICATE_ATTRACTION")).toBe(true);
    // "Dinner" repeats on both days and must never be flagged — it's a routine, expected repeat.
    expect(
      result.issues.filter((issue) => issue.code === "DUPLICATE_ATTRACTION").every((issue) => !/dinner/i.test(issue.detail))
    ).toBe(true);
  });

  it("flags an arrival day that is too heavy when the arrival time is unknown (always true in this engine), but never flags a day whose only activity IS the arrival/check-in itself", () => {
    const heavy = validateItineraryText("Day 1\n09:00 Eiffel Tower\n11:00 Louvre Museum\n13:00 Lunch\n15:00 Seine cruise", {
      hasChildren: false,
      hasInfants: false
    });
    expect(heavy.issues.some((issue) => issue.code === "ARRIVAL_DAY_TOO_HEAVY")).toBe(true);

    const light = validateItineraryText("Day 1\n09:00 Arrival and hotel check-in", { hasChildren: false, hasInfants: false });
    expect(light.issues.some((issue) => issue.code === "ARRIVAL_DAY_TOO_HEAVY")).toBe(false);
  });

  it("flags an international departure day with no airport-transit buffer", () => {
    const noBuffer = validateItineraryText("Day 1\n14:00 Arrival\nDay 2\n18:30 Last-minute shopping", {
      hasChildren: false,
      hasInfants: false
    });
    expect(noBuffer.issues.some((issue) => issue.code === "DEPARTURE_DAY_NO_AIRPORT_BUFFER")).toBe(true);

    const buffered = validateItineraryText("Day 1\n14:00 Arrival\nDay 2\n10:00 Last-minute shopping\n13:00 Head to airport", {
      hasChildren: false,
      hasInfants: false
    });
    expect(buffered.issues.some((issue) => issue.code === "DEPARTURE_DAY_NO_AIRPORT_BUFFER")).toBe(false);
  });

  it("requires a reasonable meal break every day when a child is traveling, and both a meal AND a rest/nap break when an infant is traveling", () => {
    const noMealForChild = validateItineraryText("Day 1\n14:00 Museum\n16:00 Park", { hasChildren: true, hasInfants: false });
    expect(noMealForChild.issues.some((issue) => issue.code === "MISSING_CHILD_INFANT_BREAK")).toBe(true);

    const noRestForInfant = validateItineraryText("Day 1\n14:00 Museum\n16:00 Lunch", { hasChildren: false, hasInfants: true });
    expect(noRestForInfant.issues.some((issue) => issue.code === "MISSING_CHILD_INFANT_BREAK")).toBe(true);

    const wellPacedForInfant = validateItineraryText("Day 1\n14:00 Lunch\n15:30 Rest/nap break\n17:00 Short walk", {
      hasChildren: false,
      hasInfants: true
    });
    expect(wellPacedForInfant.issues.some((issue) => issue.code === "MISSING_CHILD_INFANT_BREAK")).toBe(false);
  });

  it("flags a day whose total scheduled span exceeds the configured daily limit", () => {
    const overLimit = validateItineraryText("Day 1\n06:00 Sunrise hike\n23:00 Night market", { hasChildren: false, hasInfants: false });
    expect(overLimit.issues.some((issue) => issue.code === "DAILY_DURATION_EXCEEDS_LIMIT")).toBe(true);

    const withinCustomLimit = validateItineraryText("Day 1\n06:00 Sunrise hike\n23:00 Night market", {
      hasChildren: false,
      hasInfants: false,
      maxDailyActivityMinutes: 20 * 60
    });
    expect(withinCustomLimit.issues.some((issue) => issue.code === "DAILY_DURATION_EXCEEDS_LIMIT")).toBe(false);
  });

  it("treats unparseable text as invalid rather than silently passing it through", () => {
    const result = validateItineraryText("Sounds like a wonderful trip! Let me know if you need anything else.", {
      hasChildren: false,
      hasInfants: false
    });
    expect(result).toEqual({ valid: false, issues: [{ code: "UNPARSEABLE", day: null, detail: expect.any(String) }] });
  });

  it("never claims to validate real, live opening hours — it is a purely structural check", () => {
    const result = validateItineraryText("Day 1\n14:00 Museum", { hasChildren: false, hasInfants: false });
    const allText = JSON.stringify(result);
    expect(allText).not.toMatch(/opening hours (?:are )?(?:verified|confirmed|checked|validated)/i);
  });

  it("orchestrator integration: an invalid (arrival-day-too-heavy) LLM itinerary is swapped for the safe deterministic fallback, and the swap is recorded in diagnostics — never shown to the traveler as-is", async () => {
    const real = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n08:00 Eiffel Tower\n09:00 Louvre Museum\n10:00 Arc de Triomphe\n11:00 Seine cruise"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Paris",
      travelMonth: "March",
      adults: 2,
      days: 3
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    // The unsafe, arrival-day-overloaded LLM output must never reach the traveler verbatim — it is
    // replaced by the deterministic, already-safe fallback template (which is trusted by policy and not
    // re-validated against these same invariants — see `safeGenerateItinerary`'s own doc comment).
    expect(result.content).not.toContain("08:00 Eiffel Tower");
    expect(result.content).toMatch(/Paris ke liye din-wise plan|Here's a day-by-day plan for Paris/i);
    expect(orchestrator.lastDiagnostics?.itineraryFallbackUsed).toBe(true);
    expect(orchestrator.lastDiagnostics?.itineraryValidationIssues).toContain("ARRIVAL_DAY_TOO_HEAVY");
  });

  it("orchestrator integration: a well-formed LLM itinerary passes through unmodified — the validator never rewrites content that already satisfies every invariant", async () => {
    const wellFormed = "Day 1\n14:00 Hotel check-in\n15:30 Old Town walk\n19:00 Dinner";
    const real = fakeProvider({ extraction: {}, intent: "request_plan", reply: wellFormed });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      destinationCity: "Prague",
      travelMonth: "March",
      adults: 2,
      days: 1
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "give me a day by day itinerary" }] });
    // The validator's own invariant: the itinerary body itself is untouched. The Goal Engine (see
    // conversation-completion.ts) may still append a short "you might also like" aside after it — that's
    // a separate, deliberate addition, not a rewrite of the validated content.
    expect(result.content.startsWith(wellFormed)).toBe(true);
  });
});

describe("TravelEmployeeLlmOrchestrator: onboarding (COLLECT_NAME gate)", () => {
  it("asks for the name before any trip-detail question when nothing is known yet", async () => {
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toMatch(/may i know your name/i);
    expect(orchestrator.lastStage).toBe("COLLECT_NAME");
  });

  it("acknowledges a destination stated before the name is known, but still asks for the name (never skips onboarding)", async () => {
    const real = fakeProvider({ extraction: { destinationCity: "Delhi" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "Delhi jana hai" }] });
    expect(result.content).toMatch(/delhi/i);
    expect(result.content).toMatch(/may i know your name/i);
    expect(orchestrator.lastStage).toBe("COLLECT_NAME");
  });

  it("replies in Hinglish when the traveler has been writing Hinglish, even for the name-gate question", async () => {
    const real = fakeProvider({ extraction: { destinationCity: "Delhi" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "Delhi jana hai" }] });
    expect(result.content).toMatch(/planning shuru karne se pehle/i);
  });

  it("captures name and destination together in one message, acknowledges the name, and proceeds straight to the remaining trip details", async () => {
    const real = fakeProvider({
      extraction: { customerName: "Krishna", destinationCity: "Delhi" },
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "My name is Krishna and I want to visit Delhi" }]
    });
    expect(orchestrator.lastEntities.customerName).toBe("Krishna");
    expect(orchestrator.lastEntities.destinationCity).toBe("Delhi");
    expect(orchestrator.lastStage).not.toBe("COLLECT_NAME");
    expect(result.content).not.toMatch(/may i know your name/i);
  });

  it("offers the Intent Discovery menu once the name is captured with no trip content stated yet, instead of assuming a trip is being planned", async () => {
    const real = fakeProvider({ extraction: { customerName: "Krishna" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, EMPTY_TRAVEL_ENTITIES);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "My name is Krishna" }] });
    expect(orchestrator.lastEntities.customerName).toBe("Krishna");
    expect(orchestrator.lastStage).toBe("DISCOVER_INTENT");
    expect(result.content).toMatch(/krishna/i);
    expect(result.content).toMatch(/how may i help you today/i);
    expect(result.content).toMatch(/plan a trip/i);
    expect(result.content).toMatch(/build an itinerary/i);
    expect(result.content).toMatch(/estimate costs/i);
    expect(result.content).toMatch(/explain policies/i);
    expect(result.content).toMatch(/answer travel questions/i);
    expect(result.content).not.toMatch(/where would you like to travel|which city/i);
  });

  it("resumes normal slot collection on the very next turn after the Intent Discovery menu", async () => {
    const real1 = fakeProvider({ extraction: { customerName: "Krishna" }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "My name is Krishna" }] });
    expect(orchestrator1.lastStage).toBe("DISCOVER_INTENT");

    const real2 = fakeProvider({ extraction: { destinationCity: "Goa" }, intent: "provide_trip_details" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const result = await orchestrator2.complete({
      messages: [{ role: "user", content: "I want to plan a trip to Goa" }]
    });
    expect(result.content).not.toMatch(/how may i help you today/i);
    expect(orchestrator2.lastEntities.destinationCity).toBe("Goa");
  });

  it("never re-asks for the name once known, and a later 'start a new trip' never wipes it (onboarding is done once, not per trip)", async () => {
    const real1 = fakeProvider({ extraction: { customerName: "Alex", destinationCity: "London" }, intent: "provide_trip_details" });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "I'm Alex, planning a trip to London" }] });
    expect(orchestrator1.lastEntities.customerName).toBe("Alex");

    const real2 = fakeProvider({ extraction: { destinationCity: "Paris" }, intent: "start_new_trip" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(real2, config, orchestrator1.lastEntities, orchestrator1.lastMemory);
    const result = await orchestrator2.complete({
      messages: [{ role: "user", content: "actually, let's plan a trip to Paris instead" }]
    });
    expect(orchestrator2.lastEntities.customerName).toBe("Alex");
    expect(orchestrator2.lastEntities.destinationCity).toBe("Paris");
    expect(result.content).not.toMatch(/may i know your name/i);
  });
});

describe("Trip State Manager regression: 'create itinerary' must use everything already captured, never behave as if it forgot", () => {
  it("generates the itinerary from entities captured on an earlier turn, without re-asking for anything already known — reproduces and fixes the reported production regression", async () => {
    // Turn 1: the traveler states their full trip in one message. `orchestrator1.lastEntities` is exactly
    // what AgentService persists to AgentMemory (see `entitiesToStoredState`) and reloads on the next turn
    // — TripState, never the raw chat transcript, is the source of truth carried forward.
    const real1 = fakeProvider({
      extraction: {
        customerName: "Krishna",
        destinationCity: "Paris",
        travelMonth: "January",
        days: 5,
        adults: 2
      },
      intent: "provide_trip_details"
    });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({
      messages: [{ role: "user", content: "I'm Krishna, planning a 5 day trip to Paris in January for 2 adults" }]
    });
    expect(orchestrator1.lastEntities.destinationCity).toBe("Paris");

    // Turn 2, a brand-new orchestrator instance constructed only from the PERSISTED prior entities — this
    // is exactly how AgentService rebuilds the orchestrator on every request (see `execute()`), never from
    // chat history. If TripState were being silently dropped/regenerated, this turn would either ask for
    // destination/dates again or fail to produce an itinerary at all.
    const real2 = fakeProvider({
      extraction: {},
      intent: "request_plan",
      reply: "Day 1\n10:00 Eiffel Tower\n14:00 Louvre Museum\n19:00 Seine river dinner cruise"
    });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    const result = await orchestrator2.complete({ messages: [{ role: "user", content: "Create itinerary" }] });

    // The itinerary generator validates/regenerates content rather than trusting the raw LLM reply
    // verbatim (see `safeGenerateItinerary`) — the destination/traveler count it renders is the real proof
    // TripState (not the scripted reply text) drove this response.
    expect(result.content).toContain("Day 1");
    expect(result.content).toContain("Paris");
    expect(result.content).toContain("2 adults");
    // Never the onboarding/slot-collection questions this bug caused — proof the assistant did not
    // "forget" the destination, dates, or traveler count already captured.
    expect(result.content).not.toMatch(/may i know your name|where would you like to travel|when are you planning|how many travelers/i);
    expect(orchestrator2.lastEntities.destinationCity).toBe("Paris");
    expect(orchestrator2.lastEntities.customerName).toBe("Krishna");
    expect(orchestrator2.lastStage).toBe("ITINERARY_SUMMARY");
  });

  it("asks ONLY for the missing mandatory fields when 'create itinerary' is requested before the trip is fully known — never restarts collection from scratch", async () => {
    const partialTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      customerName: "Krishna",
      destinationCity: "Tokyo"
      // travelMonth/days deliberately still unknown — only these should be asked for.
    };
    const real = fakeProvider({ extraction: {}, intent: "request_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, partialTrip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "Create itinerary" }] });
    expect(result.content).not.toMatch(/where would you like to travel|which city|may i know your name/i);
    expect(orchestrator.lastEntities.destinationCity).toBe("Tokyo");
  });
});

describe("Entity Merge Rules: a later correction always wins over an already-confirmed value", () => {
  it('Destination = London, then "I actually want Paris" -> Destination becomes Paris', () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London" };
    const priorConfirmation = confirmAll(prior);
    const merged = mergeConfirmedEntities(
      prior,
      priorConfirmation,
      { destinationCity: "Paris" },
      "modify_trip"
    );
    expect(merged.values.destinationCity).toBe("Paris");
    expect(merged.destinationChanged).toEqual({ from: "London", to: "Paris" });
  });

  it('Adults = 2, then "We\'ll be 5" -> Adults becomes 5', () => {
    const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "London", adults: 2 };
    const priorConfirmation = confirmAll(prior);
    const merged = mergeConfirmedEntities(prior, priorConfirmation, { adults: 5 }, "modify_trip");
    expect(merged.values.adults).toBe(5);
  });

  it("through the real orchestrator turn (not just the pure merge function): a confirmed destination is replaced end to end", async () => {
    const real1 = fakeProvider({
      extraction: { customerName: "Alex", destinationCity: "London" },
      intent: "provide_trip_details"
    });
    const orchestrator1 = new TravelEmployeeLlmOrchestrator(real1, config, EMPTY_TRAVEL_ENTITIES);
    await orchestrator1.complete({ messages: [{ role: "user", content: "I'm Alex, planning a trip to London" }] });
    expect(orchestrator1.lastEntities.destinationCity).toBe("London");

    const real2 = fakeProvider({ extraction: { destinationCity: "Paris" }, intent: "modify_trip" });
    const orchestrator2 = new TravelEmployeeLlmOrchestrator(
      real2,
      config,
      orchestrator1.lastEntities,
      orchestrator1.lastMemory
    );
    await orchestrator2.complete({ messages: [{ role: "user", content: "I actually want Paris" }] });
    expect(orchestrator2.lastEntities.destinationCity).toBe("Paris");
  });
});

describe("TripState field: visaRequired / passportStatus (extraction, merge, and storage round-trip)", () => {
  it("parseExtractedEntities reads visaRequired (boolean) and passportStatus (string) from the LLM's JSON", () => {
    const parsed = parseExtractedEntities(
      JSON.stringify({ visaRequired: true, passportStatus: "valid until 2030" })
    );
    expect(parsed.visaRequired).toBe(true);
    expect(parsed.passportStatus).toBe("valid until 2030");
  });

  it("ignores a non-boolean visaRequired value rather than guessing", () => {
    expect(parseExtractedEntities(JSON.stringify({ visaRequired: "yes" })).visaRequired).toBeNull();
  });

  it("merges visaRequired/passportStatus into TripState the same generic way as every other scalar field", () => {
    const merged = mergeTravelEntities(EMPTY_TRAVEL_ENTITIES, {
      visaRequired: true,
      passportStatus: "expired"
    });
    expect(merged.visaRequired).toBe(true);
    expect(merged.passportStatus).toBe("expired");
  });

  it("round-trips through entitiesToStoredState/entitiesFromStoredState without loss", () => {
    const entities: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      customerName: "Alex",
      visaRequired: true,
      passportStatus: "renewing"
    };
    const stored = entitiesToStoredState(entities, "COLLECT_DESTINATION");
    const restored = entitiesFromStoredState(stored);
    expect(restored.visaRequired).toBe(true);
    expect(restored.passportStatus).toBe("renewing");
  });

  it("never infers visaRequired merely from the trip being international — only an explicit statement sets it", async () => {
    const real = fakeProvider({
      extraction: { destinationCity: "Paris" }, // no visaRequired stated
      intent: "provide_trip_details"
    });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES,
      customerName: "Alex",
      originCity: "New Delhi"
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "I want to go to Paris" }] });
    expect(orchestrator.lastEntities.visaRequired).toBeNull();
  });
});

describe("TripState field: tripPurpose (leisure/business — asked once alongside Intent Discovery)", () => {
  // The menu's wording itself (buildIntentDiscoveryMessage) is covered in travel.runtime.spec.ts.
  it("parseExtractedEntities reads tripPurpose as LEISURE or BUSINESS, case-insensitively", () => {
    expect(parseExtractedEntities(JSON.stringify({ tripPurpose: "leisure" })).tripPurpose).toBe("LEISURE");
    expect(parseExtractedEntities(JSON.stringify({ tripPurpose: "BUSINESS" })).tripPurpose).toBe("BUSINESS");
  });

  it("ignores any value that isn't exactly LEISURE or BUSINESS, rather than guessing", () => {
    expect(parseExtractedEntities(JSON.stringify({ tripPurpose: "vacation" })).tripPurpose).toBeNull();
    expect(parseExtractedEntities(JSON.stringify({}))?.tripPurpose ?? null).toBeNull();
  });

  it("merges into TripState the same generic way as every other scalar field and round-trips through storage", () => {
    const merged = mergeTravelEntities(EMPTY_TRAVEL_ENTITIES, { tripPurpose: "BUSINESS" });
    expect(merged.tripPurpose).toBe("BUSINESS");
    const stored = entitiesToStoredState(merged, "DISCOVER_INTENT");
    expect(entitiesFromStoredState(stored).tripPurpose).toBe("BUSINESS");
  });

  it("captures the traveler's answer through a real orchestrator turn, without it ever blocking any other flow", async () => {
    const real = fakeProvider({ extraction: { tripPurpose: "LEISURE" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
      ...EMPTY_TRAVEL_ENTITIES,
      customerName: "Krishna"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "leisure" }] });
    expect(orchestrator.lastEntities.tripPurpose).toBe("LEISURE");
    // Trip purpose is never a mandatory slot — it must never appear as something the assistant is
    // blocked on or re-asks about.
    expect(result.content).not.toMatch(/leisure or business/i);
  });
});

describe("Conversation Completion & Lead Capture", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Krishna",
    originCity: "New Delhi",
    destinationCity: "Paris",
    travelMonth: "August",
    days: 5,
    adults: 2,
    budget: 2000,
    budgetCurrency: "USD"
  };

  // The completion offer takes priority over Goal Engine suggestions the first time a conversation
  // becomes ready (see "Proactive completion offer" below) — these tests isolate Goal Engine behavior by
  // starting from a conversation where that offer has already been made and resolved (DECLINED), exactly
  // as a real multi-turn conversation would be by the time this kind of follow-up question comes up.
  const goalEngineMemory = { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, completionStage: "DECLINED" as const };

  describe("Goal Engine: context-aware suggested next actions", () => {
    it("after a budget estimate, suggests itinerary, hotels, flights, and visa cost", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, goalEngineMemory);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
      expect(result.content).toContain("You might also find these useful:");
      expect(result.content).toContain("• Create a full itinerary");
      expect(result.content).toContain("• Recommend hotels");
      expect(result.content).toContain("• Suggest flights");
      expect(result.content).toContain("• Estimate visa cost");
    });

    it("never suggests visa cost once visaRequired is explicitly false", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...readyTrip, visaRequired: false }, goalEngineMemory);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
      expect(result.content).toContain("You might also find these useful:");
      expect(result.content).not.toContain("Estimate visa cost");
    });

    it("never re-suggests an itinerary once one has already been generated", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...goalEngineMemory,
        lastGeneratedItinerary: "Day 1: arrive in Paris."
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
      expect(result.content).toContain("You might also find these useful:");
      expect(result.content).not.toContain("Create a full itinerary");
    });

    it("after an itinerary, suggests hotels, restaurants, weather, and a packing checklist", async () => {
      const real = fakeProvider({
        extraction: {},
        intent: "request_plan",
        reply: "Day 1\n09:00 Arrive\n12:00 Lunch\n15:00 Museum"
      });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, goalEngineMemory);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "create an itinerary" }] });
      expect(result.content).toContain("• Recommend hotels");
      expect(result.content).toContain("• Restaurant suggestions");
      expect(result.content).toContain("• Weather for your travel dates");
      expect(result.content).toContain("• Packing checklist");
    });

    it("never appends suggestions to a mid-collection question or a pending tool call", async () => {
      const incompleteTrip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Krishna" };
      const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, incompleteTrip);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "hi" }] });
      expect(result.content).not.toContain("You might also find these useful:");
    });
  });

  describe("Proactive completion offer", () => {
    it("offers to submit the request in place of Goal Engine suggestions, the first time the trip is ready", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
      expect(result.content).toContain(buildCompletionOfferMessage("Krishna", "ENGLISH"));
      expect(result.content).not.toContain("You might also find these useful:");
      expect(orchestrator.lastMemory.completionStage).toBe("OFFERED");
    });

    it("never offers before the trip is complete, even on an eligible branch", async () => {
      const incompleteTrip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Krishna", destinationCity: "Paris" };
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, incompleteTrip);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "hello" }] });
      expect(result.content).not.toContain(buildCompletionOfferMessage("Krishna", "ENGLISH"));
      expect(orchestrator.lastMemory.completionStage).toBe("NOT_OFFERED");
    });

    it("is never repeated once already offered — a later eligible turn gets Goal Engine suggestions instead", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        completionStage: "OFFERED"
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what about hotels" }] });
      expect(result.content).not.toContain(buildCompletionOfferMessage("Krishna", "ENGLISH"));
    });

    it("says yes -> asked for a phone number, and stage moves to AWAITING_CONTACT", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        completionStage: "OFFERED"
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "yes please" }] });
      expect(result.content).toBe(buildContactRequestMessage("ENGLISH"));
      expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
    });

    it("says no -> declines, never asks again, and the conversation continues normally", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question", reply: "Sure, here's more detail." });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        completionStage: "OFFERED"
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "no thanks" }] });
      expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
      // A decline is not a dead end — this turn's message still gets a real, normal reply.
      expect(result.content).not.toBe("");
    });

    it("an unrelated reply while OFFERED leaves the offer open for a later turn", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        completionStage: "OFFERED"
      });
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's the weather like" }] });
      expect(orchestrator.lastMemory.completionStage).toBe("OFFERED");
      expect(result.content).not.toBe(buildContactRequestMessage("ENGLISH"));
    });
  });

  describe("Contact collection", () => {
    const awaitingContactMemory = { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, completionStage: "AWAITING_CONTACT" as const };
    const contactTools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.create_lead", description: "", inputSchema: {} }
    ];

    it("a valid phone number calls travel.create_lead with the trip captured so far", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, awaitingContactMemory);
      const result = await orchestrator.complete({
        messages: [{ role: "user", content: "+91 98765 43210" }],
        tools: [{ name: "travel.create_lead", description: "", inputSchema: {} }]
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.name).toBe("travel.create_lead");
      const args = result.toolCalls[0]?.arguments as Record<string, unknown>;
      expect(args.reference).toMatch(/^TRV-[A-Z0-9]{6}$/);
      expect(args.phoneNumber).toBe("+919876543210");
      expect(args.customerName).toBe("Krishna");
      expect(args.departureCity).toBe("New Delhi");
      expect(args.destination).toBe("Paris");
      expect(args.passengers).toBe("2 adults");
      expect(args.budgetAmount).toBe(2000);
      expect(args.budgetCurrency).toBe("USD");
      expect(typeof args.conversationSummary).toBe("string");
    });

    it("an acknowledgement is handled without being falsely validated as an invalid phone", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, awaitingContactMemory);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "okay thank you" }] });
      expect(result.content).toBe(buildPendingContactAcknowledgement("ENGLISH"));
      expect(orchestrator.lastMemory.completionStage).toBe("AWAITING_CONTACT");
      expect(orchestrator.lastMemory.pendingInputAction).toBe("AWAITING_LEAD_CONTACT");
      expect(real.complete).not.toHaveBeenCalled();
    });

    it("answers a new budget request while contact is pending, then accepts the next phone without stale search", async () => {
      const trip = {
        ...readyTrip,
        originCity: "Delhi",
        destinationCity: "Dubai",
        departureDate: "2027-01-12",
        travelMonth: "January",
        days: 4,
        nights: null,
        adults: 3,
        totalTravellers: 3,
        budget: 10_000,
        budgetCurrency: "AED"
      };
      const memory = {
        ...awaitingContactMemory,
        pendingInputAction: "AWAITING_LEAD_CONTACT" as const,
        pendingAction: "SEARCH_OPTIONS" as const,
        providerFailure: {
          failedAction: "SEARCH_LIVE_OPTIONS" as const,
          provider: "travel.search_flights",
          failedAt: new Date().toISOString(),
          retryable: true,
          selectedRecoveryAction: null,
          menuActive: true,
          menuExpiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      };
      const real = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, trip, memory);

      const budget = await orchestrator.complete({
        messages: [{ role: "user", content: "share the minimal possible budget" }],
        tools: contactTools
      });
      expect(budget.content).toMatch(/AED/);
      expect(budget.content).toMatch(/budget|estimate/i);
      expect(budget.content).not.toMatch(/you'?re welcome|retrieve the options|mobile number/i);
      expect(budget.toolCalls).toEqual([]);
      expect(orchestrator.lastMemory.pendingInputAction).toBe("AWAITING_LEAD_CONTACT");
      expect(orchestrator.lastEntities).toMatchObject({
        originCity: "Delhi",
        destinationCity: "Dubai",
        adults: 3,
        totalTravellers: 3,
        days: 4,
        budget: 10_000,
        budgetCurrency: "AED"
      });

      const phone = await orchestrator.complete({
        messages: [{ role: "user", content: "8380031193" }],
        tools: contactTools
      });
      expect(phone.toolCalls.map((call) => call.name)).toEqual(["travel.create_lead"]);
      expect(phone.toolCalls[0]?.arguments.phoneNumber).toBe("8380031193");
      expect(phone.content).not.toMatch(/retrieve the options/i);
      expect(orchestrator.lastMemory.pendingAction).toBeNull();
      expect(orchestrator.providerFailure).toBeNull();
    });

    it("a standalone phone after closure asks for consent and cannot become passenger input or resume search", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const closedMemory = {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        conversationClosed: true,
        pendingAction: "SEARCH_OPTIONS" as const,
        providerFailure: {
          failedAction: "SEARCH_LIVE_OPTIONS" as const,
          provider: "travel.search_flights",
          failedAt: new Date().toISOString(),
          retryable: true,
          selectedRecoveryAction: null,
          menuActive: true,
          menuExpiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      };
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, closedMemory);
      const result = await orchestrator.complete({
        messages: [{ role: "user", content: "8380031193" }],
        tools: contactTools
      });
      expect(result.content).toMatch(/looks like a mobile number/i);
      expect(result.content).toMatch(/create a travel enquiry|callback/i);
      expect(result.toolCalls).toEqual([]);
      expect(orchestrator.lastEntities.adults).toBe(2);
      expect(orchestrator.lastMemory.pendingInputAction).toBe("CONFIRM_STANDALONE_CONTACT_USE");
      expect(orchestrator.lastMemory.pendingAction).toBeNull();
      expect(orchestrator.providerFailure).toBeNull();
      expect(real.complete).not.toHaveBeenCalled();
    });

    it("confirmation after standalone contact creates one lead with the stored contact and no search", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const memory = {
        ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
        pendingInputAction: "CONFIRM_STANDALONE_CONTACT_USE" as const,
        pendingContactValue: "8380031193"
      };
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, memory);
      const result = await orchestrator.complete({
        messages: [{ role: "user", content: "yes, create the enquiry" }],
        tools: contactTools
      });
      expect(result.toolCalls.map((call) => call.name)).toEqual(["travel.create_lead"]);
      expect(result.toolCalls[0]?.arguments.phoneNumber).toBe("8380031193");
      expect(real.complete).not.toHaveBeenCalled();
    });

    it("declining while awaiting contact stops the flow instead of continuing to ask", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, awaitingContactMemory);
      const result = await orchestrator.complete({ messages: [{ role: "user", content: "no, never mind" }] });
      expect(result.content).not.toBe(buildInvalidPhoneMessage("ENGLISH"));
      expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
    });

    it("confirms with the reference number once the lead tool call actually succeeds", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, awaitingContactMemory);
      await orchestrator.complete({
        messages: [{ role: "user", content: "+919876543210" }],
        tools: [{ name: "travel.create_lead", description: "", inputSchema: {} }]
      });
      const followUp = await orchestrator.complete({
        messages: [{ role: "tool", content: JSON.stringify({ leadId: "lead-1", reference: "TRV-4F2B91" }) }]
      });
      expect(followUp.content).toBe(buildLeadCapturedMessage("Krishna", "TRV-4F2B91", "ENGLISH"));
      expect(followUp.content).toContain("TRV-4F2B91");
      expect(orchestrator.lastMemory.completionStage).toBe("CAPTURED");
    });

    it("falls back to an honest message, never a fabricated reference, when the save fails", async () => {
      const real = fakeProvider({ extraction: {}, intent: "ask_question" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, awaitingContactMemory);
      await orchestrator.complete({
        messages: [{ role: "user", content: "+919876543210" }],
        tools: [{ name: "travel.create_lead", description: "", inputSchema: {} }]
      });
      const followUp = await orchestrator.complete({
        messages: [{ role: "tool", content: JSON.stringify({ success: false }) }]
      });
      expect(followUp.content).not.toContain("Reference Number");
      expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
    });
  });

  describe("completionStage persists across turns through stored state", () => {
    it.each(["NOT_OFFERED", "OFFERED", "AWAITING_CONTACT", "CAPTURED", "DECLINED"] as const)(
      "round-trips %s",
      (stage) => {
        const stored = entitiesToStoredState(readyTrip, "RECOMMEND_OPTIONS", {
          ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
          completionStage: stage
        });
        expect(memoryFromStoredState(stored).completionStage).toBe(stage);
      }
    );

    it("defaults an older/malformed stored document to NOT_OFFERED rather than guessing", () => {
      expect(memoryFromStoredState({}).completionStage).toBe("NOT_OFFERED");
      expect(memoryFromStoredState({ completionStage: "SOMETHING_ELSE" }).completionStage).toBe("NOT_OFFERED");
    });
  });

  describe("formatPassengerSummaryForLead / buildLeadConversationSummary", () => {
    it("formats a full composition breakdown", () => {
      expect(formatPassengerSummaryForLead({ ...EMPTY_TRAVEL_ENTITIES, adults: 2, children: 1 })).toBe(
        "2 adults, 1 child"
      );
    });

    it("falls back to an ambiguous total only when no breakdown was ever given", () => {
      expect(formatPassengerSummaryForLead({ ...EMPTY_TRAVEL_ENTITIES, totalTravellers: 5 })).toBe("5 travellers");
      expect(formatPassengerSummaryForLead(EMPTY_TRAVEL_ENTITIES)).toBeNull();
    });

    it("summarizes route, dates, passengers, and budget on one line", () => {
      const summary = buildLeadConversationSummary(readyTrip);
      expect(summary).toContain("New Delhi -> Paris");
      expect(summary).toContain("August");
      expect(summary).toContain("2 adults");
      expect(summary).toContain("Budget: 2000 USD");
    });
  });
});

describe("Production UAT fix: date extraction — never assume a lone date is a return date", () => {
  describe("guardReturnDateAssumption", () => {
    it("reinterprets a lone returnDate as departureDate when the message gives no return/back signal", () => {
      expect(guardReturnDateAssumption("I'll travel on 15 August", { returnDate: "2026-08-15" })).toEqual({
        departureDate: "2026-08-15",
        returnDate: null
      });
    });

    it("leaves returnDate alone when the message explicitly signals a return/back date", () => {
      expect(
        guardReturnDateAssumption("leaving on the 15th, back on the 20th", { returnDate: "2026-08-20" })
      ).toEqual({ returnDate: "2026-08-20" });
      expect(guardReturnDateAssumption("returning 20 Dec", { returnDate: "2026-12-20" })).toEqual({
        returnDate: "2026-12-20"
      });
      expect(guardReturnDateAssumption("staying till the 20th", { returnDate: "2026-08-20" })).toEqual({
        returnDate: "2026-08-20"
      });
    });

    it("never touches returnDate when departureDate is already present (two real dates were given)", () => {
      expect(
        guardReturnDateAssumption("15 Aug to 20 Aug", { departureDate: "2026-08-15", returnDate: "2026-08-20" })
      ).toEqual({ departureDate: "2026-08-15", returnDate: "2026-08-20" });
    });

    it("is a no-op when there is no returnDate to guard", () => {
      expect(guardReturnDateAssumption("hello", { departureDate: "2026-08-15" })).toEqual({
        departureDate: "2026-08-15"
      });
    });
  });

  describe("orchestrator integration: a single stated date is always captured as departureDate", () => {
    it("a lone date with no return/back wording never becomes returnDate", async () => {
      const real = fakeProvider({ extraction: { returnDate: "2026-08-15" }, intent: "provide_trip_details" });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
        ...EMPTY_TRAVEL_ENTITIES,
        customerName: "Alex"
      });
      await orchestrator.complete({ messages: [{ role: "user", content: "I want to travel on 15 August" }] });
      expect(orchestrator.lastEntities.departureDate).toBe("2026-08-15");
      expect(orchestrator.lastEntities.returnDate).toBeNull();
    });

    it("an explicit 'back on'/'return' wording is still captured as returnDate", async () => {
      const real = fakeProvider({
        extraction: { departureDate: "2026-08-15", returnDate: "2026-08-20" },
        intent: "provide_trip_details"
      });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
        ...EMPTY_TRAVEL_ENTITIES,
        customerName: "Alex"
      });
      await orchestrator.complete({
        messages: [{ role: "user", content: "leaving 15 August, back on 20 August" }]
      });
      expect(orchestrator.lastEntities.departureDate).toBe("2026-08-15");
      expect(orchestrator.lastEntities.returnDate).toBe("2026-08-20");
    });
  });

  describe("deriveDurationFromDateRange: never re-asks for a duration two stated dates already answer", () => {
    it("computes days/nights from departureDate and returnDate when neither was stated explicitly", () => {
      const entities = { ...EMPTY_TRAVEL_ENTITIES, departureDate: "2026-08-15", returnDate: "2026-08-20" };
      const derived = deriveDurationFromDateRange(entities);
      expect(derived.nights).toBe(5);
      expect(derived.days).toBe(6);
    });

    it("never overwrites an explicitly stated duration", () => {
      const entities = { ...EMPTY_TRAVEL_ENTITIES, departureDate: "2026-08-15", returnDate: "2026-08-20", days: 3 };
      expect(deriveDurationFromDateRange(entities).days).toBe(3);
    });

    it("is a no-op when either date is missing, or the range is non-positive", () => {
      expect(deriveDurationFromDateRange({ ...EMPTY_TRAVEL_ENTITIES, departureDate: "2026-08-15" }).days).toBeNull();
      expect(
        deriveDurationFromDateRange({ ...EMPTY_TRAVEL_ENTITIES, departureDate: "2026-08-20", returnDate: "2026-08-15" })
          .days
      ).toBeNull();
    });

    it("orchestrator integration: stating both dates never leaves 'duration' as a missing field", async () => {
      const real = fakeProvider({
        extraction: { departureDate: "2026-08-15", returnDate: "2026-08-20" },
        intent: "provide_trip_details"
      });
      const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, {
        ...EMPTY_TRAVEL_ENTITIES,
        customerName: "Alex",
        originCity: "New Delhi",
        destinationCity: "Paris",
        adults: 2,
        budget: 2000,
        budgetCurrency: "USD"
      });
      const result = await orchestrator.complete({
        messages: [{ role: "user", content: "flying 15 August, returning 20 August" }]
      });
      expect(orchestrator.lastEntities.nights).toBe(5);
      expect(result.content).not.toMatch(/how many days|how many nights/i);
    });
  });
});

describe("Production UAT fix: context-aware suggestions never suggest a visa for a domestic trip", () => {
  const domesticTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Priya",
    originCity: "Mumbai",
    destinationCity: "Bangalore",
    travelMonth: "August",
    days: 3,
    adults: 2,
    budget: 500,
    budgetCurrency: "USD"
  };
  const internationalTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Priya",
    originCity: "Mumbai",
    destinationCity: "Dubai",
    travelMonth: "August",
    days: 3,
    adults: 2,
    budget: 2000,
    budgetCurrency: "USD"
  };
  const declinedMemory = { ...EMPTY_TRAVEL_CONVERSATION_MEMORY, completionStage: "DECLINED" as const };

  it("a domestic trip's budget estimate never suggests visa, insurance, or currency exchange", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, domesticTrip, declinedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
    expect(result.content).not.toMatch(/visa|insurance|currency exchange/i);
    expect(result.content).toContain("You might also find these useful:");
  });

  it("an international trip's budget estimate may suggest visa, insurance, and currency exchange", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, internationalTrip, declinedMemory);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
    expect(result.content).toContain("Estimate visa cost");
    expect(result.content).toContain("Check travel insurance options");
    expect(result.content).toContain("Currency exchange guidance");
  });

  it("an international trip explicitly told no visa is needed still gets insurance/currency, never the visa suggestion", async () => {
    const real = fakeProvider({ extraction: {}, intent: "ask_question" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(
      real,
      config,
      { ...internationalTrip, visaRequired: false },
      declinedMemory
    );
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "what's my budget" }] });
    expect(result.content).not.toContain("Estimate visa cost");
    expect(result.content).toContain("Check travel insurance options");
    expect(result.content).toContain("Currency exchange guidance");
  });
});

describe("Production UAT fix: graceful conversation closing (never restarts a previous workflow step)", () => {
  it.each(["thanks", "thank you", "thanks a lot", "that's all", "nothing else", "bye", "goodbye", "no thanks", "thanks, that's all", "thanks, bye"])(
    "%j is recognized as a farewell",
    (text) => {
      expect(isFarewellMessage(text)).toBe(true);
    }
  );

  it.each(["thanks, and what about hotels", "no, I want Paris not London", "bye week trip", "no visa needed"])(
    "%j is NOT treated as a farewell — it still carries real content",
    (text) => {
      expect(isFarewellMessage(text)).toBe(false);
    }
  );

  it("bare 'no'/'yes' are deliberately never farewells on their own (too ambiguous outside a specific ask)", () => {
    expect(isFarewellMessage("no")).toBe(false);
    expect(isFarewellMessage("yes")).toBe(false);
  });

  const incompleteTrip: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex", destinationCity: "Paris" };

  it("a farewell mid-collection ends the conversation warmly instead of asking for the next missing field", async () => {
    const real = fakeProvider({ extraction: {}, intent: "casual_conversation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, incompleteTrip);
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "thanks, that's all for now" }] });
    expect(result.content).toBe(buildFarewellMessage("Alex", "ENGLISH"));
    expect(result.content).not.toMatch(/budget|when are you travel|how many/i);
  });

  it("a farewell while a completion offer is open closes it gracefully, so it is never re-offered later", async () => {
    const readyTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "casual_conversation" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      completionStage: "OFFERED"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "no thanks, bye" }] });
    expect(result.content).toBe(buildFarewellMessage("Alex", "ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
  });

  it("a short standalone 'no' while a completion offer is open also closes gracefully, without restarting collection", async () => {
    const readyTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "reject_plan" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      completionStage: "OFFERED"
    });
    const result = await orchestrator.complete({ messages: [{ role: "user", content: "no" }] });
    expect(result.content).toBe(buildFarewellMessage("Alex", "ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
  });

  it("a decline WITH real content still falls through and gets a real answer, not a canned goodbye", async () => {
    const readyTrip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES, customerName: "Alex",
      originCity: "Chennai",
      destinationCity: "Sydney",
      travelMonth: "January",
      days: 5,
      adults: 2,
      budget: 3000,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "ask_question", reply: "Visas are not required for this route." });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, readyTrip, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      completionStage: "OFFERED"
    });
    const result = await orchestrator.complete({
      messages: [{ role: "user", content: "no, but do I need a visa for this trip" }]
    });
    expect(result.content).not.toBe(buildFarewellMessage("Alex", "ENGLISH"));
    expect(orchestrator.lastMemory.completionStage).toBe("DECLINED");
  });
});

describe("Production UAT fix: currency-change requests never loop the search-confirmation prompt", () => {
  const SEARCH_PROMPT = buildReadyToSearchPromptMessage("ENGLISH");
  // The exact UAT trip: 5 adults, Delhi -> Bangkok, 3 days / 2 nights, departure 15 Aug 2026, INR 50,000.
  const uatTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Krishna",
    originCity: "Delhi",
    destinationCity: "Bangkok",
    departureDate: "2026-08-15",
    days: 3,
    nights: 2,
    adults: 5,
    budget: 50000,
    budgetCurrency: "INR"
  };

  it("after an estimate is shown, 'share in USD' converts it and does NOT re-run search or re-ask the confirmation", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const first = new TravelEmployeeLlmOrchestrator(real1, config, uatTrip);
    const inr = await first.complete({ messages: [{ role: "user", content: "what's the budget" }] });
    expect(inr.content).toContain("INR");

    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const second = new TravelEmployeeLlmOrchestrator(real2, config, first.lastEntities, first.lastMemory);
    const usd = await second.complete({ messages: [{ role: "user", content: "share in USD" }] });
    expect(usd.content).toContain("USD");
    expect(usd.content).not.toContain(SEARCH_PROMPT);
    expect(usd.toolCalls).toEqual([]);
    // No LLM call at all — currency handling is fully deterministic and pre-extraction.
    expect(real2.calls).toHaveLength(0);
    // Original budget constraint preserved; only the display currency changed.
    expect(second.lastEntities.budget).toBe(50000);
    expect(second.lastEntities.budgetCurrency).toBe("INR");
    expect(second.lastMemory.displayCurrency).toBe("USD");
  });

  it("'estimate in usd' and bare 'usd' are idempotent — consistent USD, no search restart, no loop", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "ask_budget_guidance" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, uatTrip);
    await o1.complete({ messages: [{ role: "user", content: "what's the budget" }] });

    const o2 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, o1.lastEntities, o1.lastMemory);
    const r1 = await o2.complete({ messages: [{ role: "user", content: "share in USD" }] });
    expect(r1.content).toContain("USD");

    const o3 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, o2.lastEntities, o2.lastMemory);
    const r2 = await o3.complete({ messages: [{ role: "user", content: "estimate in usd" }] });
    expect(r2.content).toContain("USD");
    expect(r2.content).not.toContain(SEARCH_PROMPT);
    expect(r2.content).toContain(buildAlreadyInCurrencyMessage("USD", "ENGLISH"));

    const o4 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, o3.lastEntities, o3.lastMemory);
    const r3 = await o4.complete({ messages: [{ role: "user", content: "usd" }] });
    expect(r3.content).toContain("USD");
    expect(r3.content).not.toContain(SEARCH_PROMPT);
    expect(o4.lastMemory.displayCurrency).toBe("USD");
  });

  it("a currency change WHILE a search confirmation is pending preserves it and re-asks at most once, in the chosen currency", async () => {
    // Reach the "ready, awaiting authorization" state (search prompt shown, pendingAction = SEARCH_OPTIONS).
    const ready = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "provide_trip_details" }),
      config,
      { ...uatTrip, budget: 500000 }
    );
    const prompt = await ready.complete({ messages: [{ role: "user", content: "ok" }] });
    expect(prompt.content).toBe(SEARCH_PROMPT);
    expect(ready.pendingAction).toBe("SEARCH_OPTIONS");

    const o2 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, ready.lastEntities, ready.lastMemory);
    const acked = await o2.complete({ messages: [{ role: "user", content: "show it in USD" }] });
    expect(acked.content).toBe(buildCurrencyAckWithSearchPromptMessage("USD", "ENGLISH"));
    expect(acked.toolCalls).toEqual([]);
    expect(o2.pendingAction).toBe("SEARCH_OPTIONS");

    // A repeated identical currency request does NOT re-ask the search prompt (idempotent).
    const o3 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, o2.lastEntities, o2.lastMemory);
    const again = await o3.complete({ messages: [{ role: "user", content: "usd" }] });
    expect(again.content).toBe(buildDisplayCurrencySetMessage("USD", "ENGLISH"));
    expect(again.content).not.toBe(buildCurrencyAckWithSearchPromptMessage("USD", "ENGLISH"));
  });

  it("an unsupported currency gets a clear, non-looping response and changes nothing", async () => {
    const o = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, uatTrip);
    const result = await o.complete({ messages: [{ role: "user", content: "show in ZWL" }] });
    expect(result.content).toBe(buildUnsupportedCurrencyMessage("ENGLISH"));
    expect(result.content).not.toContain(buildReadyToSearchPromptMessage("ENGLISH"));
    expect(result.toolCalls).toEqual([]);
    expect(o.lastMemory.displayCurrency).toBeNull();
  });

  it("farewells are never intercepted as currency requests", async () => {
    for (const text of ["no thanks", "thank you", "thanks, that's all", "bye"]) {
      const o = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "casual_conversation" }), config, uatTrip);
      const result = await o.complete({ messages: [{ role: "user", content: text }] });
      expect(result.content).toBe(buildFarewellMessage("Krishna", "ENGLISH"));
    }
  });
});

describe("Production UAT fix: budget estimate plausibility (USD amounts are converted to the display currency, never relabeled)", () => {
  const uatTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Krishna",
    originCity: "Delhi",
    destinationCity: "Bangkok",
    departureDate: "2026-08-15",
    days: 3,
    nights: 2,
    adults: 5,
    budget: 50000,
    budgetCurrency: "INR"
  };

  it("computes canonically in the pricing source currency, then converts exactly once to the display currency", () => {
    const usd = estimateBudgetRange(uatTrip, config, "USD");
    const inr = estimateBudgetRange(uatTrip, config); // defaults to the trip's budget currency (INR)
    expect(usd.currency).toBe("USD");
    expect(usd.sourceCurrency).toBe(PRICING_SOURCE_CURRENCY);
    expect(inr.currency).toBe("INR");
    // The INR figures are a real conversion of the USD figures (rate 83), never the same digits relabeled.
    expect(inr.low).toBe(convertCurrencyAmount(usd.low, "USD", "INR"));
    expect(inr.low).toBeGreaterThan(usd.low);
    // The total still equals the sum of its converted breakdown lines (reconciliation invariant holds).
    expect(inr.low).toBe(inr.breakdown.reduce((sum, line) => sum + line.low, 0));
  });

  it("passes generic plausibility validation (finite, positive, min<=max, total=sum-of-lines)", () => {
    expect(validateBudgetEstimatePlausibility(estimateBudgetRange(uatTrip, config))).toEqual([]);
    expect(validateBudgetEstimatePlausibility(estimateBudgetRange(uatTrip, config, "USD"))).toEqual([]);
  });

  it("convertBudgetEstimate keeps the total equal to the sum of its converted breakdown lines", () => {
    const converted = convertBudgetEstimate(estimateBudgetRange(uatTrip, config, "USD"), "INR");
    expect(converted.low).toBe(converted.breakdown.reduce((sum, line) => sum + line.low, 0));
    expect(converted.high).toBe(converted.breakdown.reduce((sum, line) => sum + line.high, 0));
  });

  it("a realistic INR estimate makes an INR 50,000 group international trip come out over budget, not comfortably affordable", () => {
    const inr = estimateBudgetRange(uatTrip, config);
    const feasibility = classifyBudgetFeasibility(50000, inr);
    // With genuinely-converted INR figures, a 5-adult international trip is not feasible on INR 50,000.
    expect(feasibility.classification).toBe("BELOW_MINIMUM");
    expect(feasibility.minimum).toBeGreaterThan(50000);
  });
});

describe("Production UAT fix: FX-failure-safe conversion (never fabricates or mislabels)", () => {
  const usdSnapshot: StoredBudgetEstimate = {
    currency: "USD",
    low: 6000,
    high: 8000,
    breakdown: [{ label: "Flights", low: 1000, high: 1500 }],
    assumptions: "5 adults, 3 day(s) to Bangkok, economy class",
    computedAt: "2026-01-01T00:00:00.000Z",
    displayCurrency: "USD",
    availabilityType: "INDICATIVE"
  };

  it("convertStoredBudgetEstimateSafe returns null (not a mislabeled number) for an unsupported target currency", () => {
    expect(convertStoredBudgetEstimateSafe(usdSnapshot, "ZWL")).toBeNull();
  });

  it("convertStoredBudgetEstimateSafe converts normally for a supported target", () => {
    const converted = convertStoredBudgetEstimateSafe(usdSnapshot, "INR");
    expect(converted?.currency).toBe("INR");
    expect(converted?.low).toBe(convertCurrencyAmount(6000, "USD", "INR"));
  });

  it("buildConversionUnavailableMessage offers the original currency and never a fabricated rate", () => {
    const message = buildConversionUnavailableMessage("USD", usdSnapshot, "ENGLISH");
    expect(message).toMatch(/can't convert to USD right now/i);
    expect(message).toContain("USD");
  });
});

describe("Production UAT fix: abbreviated-year date parsing (year is never silently dropped)", () => {
  it.each([
    ["17 jan 27", "2027-01-17"],
    ["17/01/27", "2027-01-17"],
    ["17-01-27", "2027-01-17"],
    ["17 January '27", "2027-01-17"],
    ["Jan 17 27", "2027-01-17"],
    ["17 jan 2027", "2027-01-17"],
    ["5 adult 17 jan 27 for 5 days 3 rat", "2027-01-17"]
  ])("parses %j to departureDate %s", (text, expected) => {
    expect(parseExplicitTravelDate(text)?.normalizedDate).toBe(expected);
  });

  it("has no explicit date when only a bare month or duration is given", () => {
    expect(parseExplicitTravelDate("17 jan")).toBeNull();
    expect(parseExplicitTravelDate("5 days 3 nights")).toBeNull();
  });

  it("resolveTravelYear maps a two-digit year to 20YY and leaves a four-digit year unchanged", () => {
    expect(resolveTravelYear(27)).toBe(2027);
    expect(resolveTravelYear(30)).toBe(2030);
    expect(resolveTravelYear(2027)).toBe(2027);
  });

  it("augmentWithExplicitDate overrides a bare month with the full explicit date (year survives extraction)", () => {
    expect(augmentWithExplicitDate("17 jan 27", { travelMonth: "January" })).toMatchObject({
      departureDate: "2027-01-17",
      travelMonth: "January"
    });
  });

  it("the year survives extraction, persistence, and later state questions through a real orchestrator", async () => {
    // The extraction model drops the year (returns only a month) — the deterministic layer recovers it.
    const real = fakeProvider({ extraction: { adults: 5, days: 5, travelMonth: "January" }, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Vedanshi" });
    await orchestrator.complete({ messages: [{ role: "user", content: "5 adults 17 jan 27 for 5 days 3 rat" }] });
    expect(orchestrator.lastEntities.departureDate).toBe("2027-01-17");
    expect(orchestrator.lastEntities.adults).toBe(5);

    // Persistence round-trip: a fresh orchestrator restored from memory still has the dated year.
    const restored = new TravelEmployeeLlmOrchestrator(
      fakeProvider({ extraction: {}, intent: "ask_question", reply: "Your trip departs 17 January 2027." }),
      config,
      orchestrator.lastEntities,
      orchestrator.lastMemory
    );
    await restored.complete({ messages: [{ role: "user", content: "exact trip date kya thi meri?" }] });
    expect(restored.lastEntities.departureDate).toBe("2027-01-17");
  });
});

describe("Production UAT fix: nights vs hotel star tier ('3 rat' is nights, never a 3-star hotel)", () => {
  it.each([
    ["5 days 3 rat", 3],
    ["5 days 3 nights", 3],
    ["5 din 3 raat", 3],
    ["5 din ke liye 3 rat", 3]
  ])("reads %j as %d nights and never a hotel star tier", (text, nights) => {
    const guarded = guardNightsVsHotelStars(text, { hotelStars: nights });
    expect(guarded.nights).toBe(nights);
    expect(guarded.hotelStars ?? null).toBeNull();
  });

  it.each(["3 star hotel", "3-star stay", "three star hotel"])(
    "keeps a genuine hotel tier from %j and does not treat it as nights",
    (text) => {
      const guarded = guardNightsVsHotelStars(text, { hotelStars: 3 });
      expect(guarded.hotelStars).toBe(3);
    }
  );

  it("captures both nights and a genuine star tier when both are stated", () => {
    const guarded = guardNightsVsHotelStars("5 days 3 nights, 4 star hotel", { hotelStars: 4 });
    expect(guarded.nights).toBe(3);
    expect(guarded.hotelStars).toBe(4);
  });

  it("Stage 9F UAT regression: 'luxary' (typo for luxury) is recognized as a genuine hotel-tier cue, never dropped as a coincidental nights match — and never touches budget or cabin class", () => {
    const guarded = guardNightsVsHotelStars("5 nights luxary", { hotelStars: 5 });
    expect(guarded.nights).toBe(5);
    expect(guarded.hotelStars).toBe(5);
    expect(guarded.budget ?? null).toBeNull();
    expect(guarded.cabinClass ?? null).toBeNull();
  });
});

describe("Production UAT fix: a bare/clarified year is never a budget amount", () => {
  it.each(["2027 me", "2027", "year is 2027", "2027 is the year"])("detects %j as a year clarification", (text) => {
    expect(detectYearClarification(text)).toBe(2027);
  });

  it.each(["budget 2027 USD", "$2027", "2027 dollars", "17 jan 2027"])(
    "does NOT treat %j as a bare year clarification",
    (text) => {
      expect(detectYearClarification(text)).toBeNull();
    }
  );

  it("hasMonetaryContext distinguishes money from a plain number", () => {
    expect(hasMonetaryContext("2027 USD")).toBe(true);
    expect(hasMonetaryContext("budget 2027")).toBe(true);
    expect(hasMonetaryContext("2027 me")).toBe(false);
  });

  it("guardYearNotBudget clears a budget the model mis-inferred from a year, and leaves a real budget alone", () => {
    expect(guardYearNotBudget("2027 me", { budget: 2027, budgetCurrency: "USD" })).toMatchObject({
      budget: null,
      budgetCurrency: null
    });
    expect(guardYearNotBudget("budget 2027 usd", { budget: 2027, budgetCurrency: "USD" })).toMatchObject({
      budget: 2027,
      budgetCurrency: "USD"
    });
  });

  it("a year correction rolls back a previously mis-stored budget and its feasibility warning", async () => {
    // Prior state carries the false budget the year was mis-read as.
    const priorWithFalseBudget: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      customerName: "Vedanshi",
      originCity: "New Delhi",
      destinationCity: "Tokyo",
      travelMonth: "January",
      adults: 5,
      days: 5,
      budget: 2027,
      budgetCurrency: "USD"
    };
    const real = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const orchestrator = new TravelEmployeeLlmOrchestrator(real, config, priorWithFalseBudget, {
      ...EMPTY_TRAVEL_CONVERSATION_MEMORY,
      budgetMode: "USER_DEFINED"
    });
    await orchestrator.complete({ messages: [{ role: "user", content: "year is 2027" }] });
    expect(orchestrator.lastEntities.budget).toBeNull();
    expect(orchestrator.lastEntities.budgetCurrency).toBeNull();
    // The year is applied to the departure date when one is present.
    if (orchestrator.lastEntities.departureDate) {
      expect(orchestrator.lastEntities.departureDate).toContain("2027");
    }
  });
});

describe("Production UAT fix: farewell preserves the journey/estimate; currency-after-farewell reuses it", () => {
  const readyTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Vedanshi",
    originCity: "New Delhi",
    destinationCity: "Tokyo",
    travelMonth: "January",
    departureDate: "2027-01-17",
    days: 5,
    nights: 3,
    adults: 5,
    budget: 500000,
    budgetCurrency: "INR"
  };

  it("'Thank you' then 'usd me btao' shows the existing estimate in USD without asking for a budget again", async () => {
    // 1) Estimate shown (budget guidance) — stores the snapshot.
    const o1 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "ask_budget_guidance" }), config, readyTrip);
    const est = await o1.complete({ messages: [{ role: "user", content: "what's the budget" }] });
    expect(est.content).toContain("INR");

    // 2) Farewell — must NOT delete the estimate/journey.
    const o2 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "casual_conversation" }), config, o1.lastEntities, o1.lastMemory);
    await o2.complete({ messages: [{ role: "user", content: "Thank you" }] });
    expect(o2.lastMemory.lastBudgetEstimate).not.toBeNull();

    // 3) Currency change after the farewell — reuses the stored estimate, shows USD, never re-asks budget.
    const o3 = new TravelEmployeeLlmOrchestrator(fakeProvider({ extraction: {}, intent: "provide_trip_details" }), config, o2.lastEntities, o2.lastMemory);
    const usd = await o3.complete({ messages: [{ role: "user", content: "usd me btao" }] });
    expect(usd.content).toContain("USD");
    expect(usd.content).not.toMatch(/approximate budget|what'?s your budget/i);
    expect(usd.toolCalls).toEqual([]);
    expect(o3.lastMemory.displayCurrency).toBe("USD");
  });
});

describe("Production UAT fix: multi-city leg parsing (Hinglish 'N days CITY me' and 'back to CITY')", () => {
  it("parses '3 days Tokyo me, 2 days London me, then back to Delhi' into connected legs", () => {
    const legs = parseJourneyLegChain("3 days Tokyo me, 2 days London me, then back to Delhi");
    expect(legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Tokyo->London", "London->Delhi"]);
  });

  it("still parses the existing 'CITY me N din ka stay' form without inventing a bogus self-loop leg", () => {
    const legs = parseJourneyLegChain("Washington se London aur fir London se Delhi, London me 3 din ka stay hai");
    expect(legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Washington->London", "London->Delhi"]);
    expect(legs.find((leg) => leg.destination === "London")?.days).toBe(3);
  });
});

describe("extractStayOverrideForCity (recovers a stay duration for a city that's never a chain DESTINATION)", () => {
  it("recovers 'Tokyo me 3 days' even though Tokyo is only ever the ORIGIN of the next parsed leg", () => {
    expect(extractStayOverrideForCity("Tokyo me 3 days, phir London me 2 days, then back to Delhi", "Tokyo")).toEqual({
      days: 3,
      nights: null
    });
  });
  it("returns null when the city isn't mentioned at all", () => {
    expect(extractStayOverrideForCity("London me 2 days", "Tokyo")).toBeNull();
    expect(extractStayOverrideForCity("London me 2 days", null)).toBeNull();
  });
});

describe("classifyRouteRelationship (route-extension vs new-trip vs multileg-correction vs ambiguous)", () => {
  it("classifies structural continuity ('London se New York jana hai' after a confirmed London destination) as EXTENSION, even with no trigger phrase", () => {
    expect(classifyRouteRelationship("london se newyork jana hai", "London", "Delhi")).toBe("EXTENSION");
  });
  it("classifies a route that returns to the traveler's home city as EXTENSION", () => {
    expect(classifyRouteRelationship("phir wapas Delhi", "London", "Delhi")).toBe("EXTENSION");
    expect(classifyRouteRelationship("then back to Delhi", "London", "Delhi")).toBe("EXTENSION");
  });
  it("is fuzzy about 'Delhi' vs 'New Delhi' so a home city stated with 'New' still matches a later bare 'Delhi' mention", () => {
    expect(classifyRouteRelationship("then back to Delhi", "London", "New Delhi")).toBe("EXTENSION");
  });
  it("classifies an explicit 'another/separate/new trip' phrase as NEW_TRIP, even if the route would otherwise look ambiguous", () => {
    expect(classifyRouteRelationship("Plan another trip from Tokyo to London", "Delhi", "Delhi")).toBe("NEW_TRIP");
    expect(classifyRouteRelationship("start a new trip", null, null)).toBe("NEW_TRIP");
  });
  it("classifies 'bhai multileg hai' as MULTILEG_CORRECTION", () => {
    expect(classifyRouteRelationship("bhai multileg hai", "New York", "Delhi")).toBe("MULTILEG_CORRECTION");
  });
  it("never treats a same-leg destination CORRECTION ('not London, Paris') as an extension, even though London matches the confirmed destination", () => {
    expect(classifyRouteRelationship("not London, Paris", "London", "Delhi")).toBe("NONE");
  });
  it("classifies a route that neither continues structurally nor states it's a new trip as AMBIGUOUS", () => {
    expect(classifyRouteRelationship("Tokyo to London", "Delhi", "Delhi")).toBe("AMBIGUOUS");
  });
  it("returns NONE when there's no active trip to relate to", () => {
    expect(classifyRouteRelationship("Tokyo to London", null, null)).toBe("NONE");
  });
  // Real UAT bug: after "plan trip to Dubai" set the confirmed destination to Dubai, a follow-up message
  // restating the SAME trip with more detail ("Delhi to Dubai on 12 August for 2 adults for 5 days") was
  // classified AMBIGUOUS purely because it happens to parse as a route ("Delhi -> Dubai") — producing the
  // nonsensical "Should I add Dubai after Dubai in the same trip?" question, and then (once the traveler
  // answered "same trip") silently discarding the dates/passenger count already given by routing into the
  // NEXT-leg-collection flow instead of the normal entity-merge path.
  it("classifies a message restating the SAME already-confirmed destination as NONE — never AMBIGUOUS, never 'add Dubai after Dubai'", () => {
    expect(classifyRouteRelationship("delhi to dubai on 12 august for 2 adult for 5 days book my round trip flight", "Dubai", null)).toBe(
      "NONE"
    );
    expect(classifyRouteRelationship("Delhi to Dubai", "Dubai", null)).toBe("NONE");
  });
});

describe("UAT regression: restating the same destination with more detail must never trigger the route-relationship clarification or lose already-given details", () => {
  it("'plan trip to Dubai' then 'Delhi to Dubai on 12 August for 2 adults for 5 days' merges straight into the SAME trip — never asks 'add Dubai after Dubai', never drops the dates/passenger count on a later turn", async () => {
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} }
    ];

    // Turn 1: "plan trip to dubai"
    const real1 = fakeProvider({ extraction: { destinationCity: "Dubai" }, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Krishna" });
    await o1.complete({ messages: [{ role: "user", content: "plan trip to dubai" }], tools });
    expect(o1.lastEntities.destinationCity).toBe("Dubai");

    // Turn 2: "delhi to dubai on 12 august 2026 for 2 adult for 5 days book my round trip flight" — restates
    // the SAME Dubai trip with full detail (a year included, so this test isolates the route-relationship/
    // fast-path bugs from the separate, legitimate "no year stated" AWAITING_TRAVEL_YEAR clarification flow).
    // Must be classified NONE (see classifyRouteRelationship above) and merge directly via the full
    // extraction path, never asking whether to "add Dubai after Dubai" and never silently dropping the
    // origin/date/days/adults already stated in this very message (the real UAT bug: the deterministic
    // fast-path bypass — triggered because "travel dates" was the pending asked field — has no route/city-
    // pair handling of its own and was dropping the origin city and demoting the full date to a bare month).
    const real2 = fakeProvider({
      extraction: {
        originCity: "Delhi",
        destinationCity: "Dubai",
        days: 5,
        adults: 2,
        departureDate: "2026-08-12",
        tripType: "ROUND_TRIP"
      },
      intent: "provide_trip_details"
    });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    const result2 = await o2.complete({
      messages: [{ role: "user", content: "delhi to dubai on 12 august 2026 for 2 adult for 5 days book my round trip flight" }],
      tools
    });
    expect(result2.content).not.toMatch(/add dubai after dubai/i);
    expect(result2.content).not.toMatch(/separate trip/i);
    expect(o2.pendingRouteClarification).toBeNull();
    expect(o2.lastEntities).toMatchObject({
      originCity: "Delhi",
      destinationCity: "Dubai",
      days: 5,
      adults: 2,
      departureDate: "2026-08-12"
    });

    // Turn 3: a later "go ahead"-style turn must see all of this already captured — no missing-fields
    // re-ask for dates/days/travelers that were already given two turns ago.
    const missing = computeMissingEntityFields(o2.lastEntities, o2.budgetMode);
    expect(missing).not.toContain("days");
    expect(missing).not.toContain("adults");
    expect(missing).not.toContain("departureDate");
  });

  it("still preserves origin/days/adults when the SAME message omits the year — only the year itself is asked for (never a full re-ask of everything already given)", async () => {
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} }
    ];
    const real1 = fakeProvider({ extraction: { destinationCity: "Dubai" }, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Krishna" });
    await o1.complete({ messages: [{ role: "user", content: "plan trip to dubai" }], tools });

    const real2 = fakeProvider({
      extraction: { originCity: "Delhi", destinationCity: "Dubai", days: 5, adults: 2, travelMonth: "August", tripType: "ROUND_TRIP" },
      intent: "provide_trip_details"
    });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    const result2 = await o2.complete({
      messages: [{ role: "user", content: "delhi to dubai on 12 august for 2 adult for 5 days book my round trip flight" }],
      tools
    });

    expect(result2.content).not.toMatch(/add dubai after dubai/i);
    expect(o2.pendingRouteClarification).toBeNull();
    // Origin/days/adults survive even though the year is genuinely still unknown — a legitimate, narrow
    // "which year?" follow-up is fine; silently re-asking origin/days/adults/dates from scratch is not.
    expect(o2.lastEntities).toMatchObject({ originCity: "Delhi", destinationCity: "Dubai", days: 5, adults: 2 });
    expect(o2.pendingInputAction).toBe("AWAITING_TRAVEL_YEAR");
  });
});

describe("UAT regression: missing-field prompts always use the real AI provider, even once the conversation is established", () => {
  // Real UAT bug: a deliberate latency/cost optimization skipped the provider entirely for every
  // "please share the next missing detail" turn once the conversation was past its first message —
  // always returning the deterministic bullet-list template (buildFallbackAskMessage) regardless of
  // whether a real, working AI provider was configured. This is what made the bot sound robotic on every
  // turn AFTER the first, even with valid credentials — the LLM (and its warm-human-consultant system
  // prompt) was simply never being called for these turns.
  it("calls the real provider (not the deterministic fallback) for a missing-field prompt on a later turn, once the customer's name is already known", async () => {
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} }
    ];
    // Turn 1: establishes the conversation (name known, no trip details yet).
    const real1 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Krishna" });
    await o1.complete({ messages: [{ role: "user", content: "hi" }], tools });

    // Turn 2 (not the first turn, no name just learned): a destination is given, days/adults/budget/dates
    // are still missing — this must go through the real provider, using its own scripted natural reply,
    // never the hardcoded bullet-list fallback text.
    const real2 = fakeProvider({
      extraction: { destinationCity: "Dubai" },
      intent: "provide_trip_details",
      reply: "Dubai's a great choice, Krishna! When are you thinking of travelling, and for how many days?"
    });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    const result2 = await o2.complete({ messages: [{ role: "user", content: "plan trip to dubai" }], tools });

    expect(real2.calls.length).toBeGreaterThan(0);
    expect(result2.content).toBe("Dubai's a great choice, Krishna! When are you thinking of travelling, and for how many days?");
    expect(result2.content).not.toMatch(/To plan this well, could you share:/);
    expect(result2.content).not.toContain("•");
  });
});

describe("projectJourneyReturnDate (final-leg arrival projection — never fabricates false precision)", () => {
  const dates = (departureDate: string | null, isAssumption = false) => ({
    travelMonth: null,
    departureDate,
    returnDate: null,
    departureDateIsAssumption: isAssumption
  });
  it("is EXACT_FROM_USER when every leg's date, including the final leg's, was stated outright", () => {
    const projection = projectJourneyReturnDate([
      { origin: "Delhi", destination: "Tokyo", dates: dates("2027-01-17") },
      { origin: "Tokyo", destination: "London", dates: dates("2027-01-20") },
      { origin: "London", destination: "Delhi", dates: dates("2027-01-22") }
    ]);
    expect(projection.finalArrivalDate).toBe("2027-01-22");
    expect(projection.confidence).toBe("EXACT_FROM_USER");
  });
  it("is DERIVED when the final leg's date was computed via day-math from a prior leg's stay length", () => {
    const projection = projectJourneyReturnDate([
      { origin: "Delhi", destination: "Tokyo", dates: dates("2027-01-17") },
      { origin: "Tokyo", destination: "London", dates: dates("2027-01-20", true) }
    ]);
    expect(projection.finalArrivalDate).toBe("2027-01-20");
    expect(projection.confidence).toBe("DERIVED");
  });
  it("returns no date (INDICATIVE) rather than fabricating one when the final leg's own date is unknown", () => {
    const projection = projectJourneyReturnDate([{ origin: "Tokyo", destination: "London", dates: dates(null) }]);
    expect(projection.finalArrivalDate).toBeNull();
    expect(projection.confidence).toBe("INDICATIVE");
  });
  it("always includes the schedule-uncertainty assumptions, regardless of confidence", () => {
    const projection = projectJourneyReturnDate([{ origin: "Tokyo", destination: "London", dates: dates("2027-01-20") }]);
    expect(projection.assumptions.length).toBeGreaterThan(0);
    expect(projection.assumptions.join(" ")).toMatch(/timezone|flight schedule/i);
  });
  it("buildReturnDateProjectionMessage never claims false precision and asks for the date instead of guessing when unknown", () => {
    const known = projectJourneyReturnDate([{ origin: "Tokyo", destination: "London", dates: dates("2027-01-22", true) }]);
    expect(buildReturnDateProjectionMessage(known, "Delhi", "ENGLISH")).toContain("2027-01-22");
    expect(buildReturnDateProjectionMessage(known, "Delhi", "ENGLISH")).toMatch(/estimated/i);
    const unknown = projectJourneyReturnDate([{ origin: "Tokyo", destination: "London", dates: dates(null) }]);
    expect(buildReturnDateProjectionMessage(unknown, "Delhi", "ENGLISH")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("describeJourneyRoute / buildMultilegCorrectionMessage / buildRouteRelationshipClarificationMessage", () => {
  it("describeJourneyRoute renders the full chain as a single A -> B -> C string", () => {
    expect(
      describeJourneyRoute([
        { origin: "Delhi", destination: "London" },
        { origin: "London", destination: "New York" }
      ])
    ).toBe("Delhi -> London -> New York");
    expect(describeJourneyRoute([])).toBe("");
  });
  it("buildMultilegCorrectionMessage acknowledges the connected route without asking to restart", () => {
    const message = buildMultilegCorrectionMessage([{ origin: "Delhi", destination: "London" }], "ENGLISH");
    expect(message).toContain("Delhi -> London");
    expect(message).toMatch(/connected|multi-city/i);
    expect(message).not.toMatch(/what'?s your budget|start over/i);
  });
  it("buildRouteRelationshipClarificationMessage asks same-trip-or-separate, never guessing", () => {
    const message = buildRouteRelationshipClarificationMessage("Delhi", "Paris", "ENGLISH");
    expect(message).toMatch(/same trip|separate trip/i);
    expect(message).toContain("Delhi");
    expect(message).toContain("Paris");
  });
});

describe("UAT acceptance — Scenario A: 'Mujhe Tokyo jana hai' -> multi-city compound total + return-date question", () => {
  it("connects New Delhi->Tokyo->London->New Delhi into ONE journey and answers total cost + Delhi landing date in one response, never just the Tokyo->London portion", async () => {
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} }
    ];

    // Turn 1: "Mujhe Tokyo jana hai"
    const real1 = fakeProvider({ extraction: { destinationCity: "Tokyo" }, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Priya" });
    await o1.complete({ messages: [{ role: "user", content: "Mujhe Tokyo jana hai" }], tools });
    expect(o1.lastEntities.destinationCity).toBe("Tokyo");

    // Turn 2: "5 adults, 17 Jan 27, 5 days 3 nights" — the deterministic date/duration guards own this, not
    // the (deliberately empty) fakeProvider extraction.
    const real2 = fakeProvider({ extraction: { adults: 5, days: 5, nights: 3 }, intent: "provide_trip_details" });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    await o2.complete({ messages: [{ role: "user", content: "5 adults, 17 Jan 27, 5 days 3 nights" }], tools });
    expect(o2.lastEntities.adults).toBe(5);
    expect(o2.lastEntities.departureDate).toBe("2027-01-17");
    expect(o2.lastEntities.days).toBe(5);
    expect(o2.lastEntities.nights).toBe(3);

    // Turn 3: "New Delhi" answers "which city are you departing from?"
    const real3 = fakeProvider({ extraction: { originCity: "New Delhi" }, intent: "provide_trip_details" });
    const o3 = new TravelEmployeeLlmOrchestrator(real3, config, o2.lastEntities, o2.lastMemory);
    await o3.complete({ messages: [{ role: "user", content: "New Delhi" }], tools });
    expect(o3.lastEntities.originCity).toBe("New Delhi");

    // Turn 4: the compound multi-city + total + return-date message.
    const real4 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o4 = new TravelEmployeeLlmOrchestrator(real4, config, o3.lastEntities, o3.lastMemory);
    const result4 = await o4.complete({
      messages: [
        {
          role: "user",
          content: "Tokyo me 3 days, phir London me 2 days, then back to Delhi. Total kharcha batao and kis date ko Delhi land karunga?"
        }
      ],
      tools
    });

    // ONE connected journey: New Delhi -> Tokyo -> London -> New Delhi (never just Tokyo -> London).
    expect(o4.journey).not.toBeNull();
    const legs = o4.journey?.legs ?? [];
    expect(legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual([
      "New Delhi->Tokyo",
      "Tokyo->London",
      "London->Delhi"
    ]);
    // Turn 4 restates the Tokyo leg's stay as "3 days" in the same breath as describing the next legs —
    // that restatement must be applied to the Tokyo leg before it's finalized (not silently dropped just
    // because Tokyo is only ever an ORIGIN within this message's own parsed leg chain), while the
    // previously-stated 3 nights (turn 2) is preserved since this message never touches nights.
    expect(legs[0]?.duration).toMatchObject({ days: 3, nights: 3 });
    // leg[1] is Tokyo->London — "London me 2 days" binds its stay duration to London, the leg's destination.
    expect(legs[1]?.duration.days).toBe(2);
    // leg[2] is London->Delhi, the final connecting/return leg — no stay was stated for it.
    expect(legs[2]?.duration.days).toBeNull();

    // Grand total + Delhi landing date answered together, in this same response.
    expect(result4.content).toMatch(/total|combined/i);
    expect(result4.content).toMatch(/land|delhi/i);
    expect(result4.content.length).toBeGreaterThan(0);
  });
});

describe("UAT acceptance — Scenario B: Delhi->London->New York, 'bhai multileg hai' correction, then Hinglish 'ji' search", () => {
  it("preserves explicit '3 rat' as nights (never silently 4 days), connects the London->New York continuation, and resolves 'bhai multileg hai' without restarting budget collection", async () => {
    const tools = [
      { name: "travel.search_flights", description: "", inputSchema: {} },
      { name: "travel.search_hotels", description: "", inputSchema: {} }
    ];

    // Turn 1: "mujhe delhi se london jana hai 3 adult aur 3 rat ke liye 26 jan 2027 ko kitna budget aayega"
    const real1 = fakeProvider({
      extraction: { originCity: "Delhi", destinationCity: "London", adults: 3 },
      intent: "ask_budget_guidance"
    });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, { ...EMPTY_TRAVEL_ENTITIES, customerName: "Anjali" });
    await o1.complete({
      messages: [
        { role: "user", content: "mujhe delhi se london jana hai 3 adult aur 3 rat ke liye 26 jan 2027 ko kitna budget aayega" }
      ],
      tools
    });
    // "3 rat" must be preserved as nights, never silently restated as "4 days".
    expect(o1.lastEntities.nights).toBe(3);
    expect(o1.lastEntities.departureDate).toBe("2027-01-26");

    // Turn 2: "london se newyork jana hai" — structural continuity (origin == confirmed destination) must
    // finalize Delhi->London as a leg and start London->New York, never overwrite London's own data in place.
    const real2 = fakeProvider({ extraction: { destinationCity: "New York" }, intent: "provide_trip_details" });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    await o2.complete({ messages: [{ role: "user", content: "london se newyork jana hai" }], tools });
    expect(o2.journey?.legs).toHaveLength(1);
    expect(o2.journey?.legs[0]).toMatchObject({ origin: "Delhi", destination: "London" });
    expect(o2.journey?.legs[0]?.duration.nights).toBe(3);
    expect(o2.lastEntities.originCity).toBe("London");
    expect(o2.lastEntities.destinationCity).toBe("New York");

    // Turn 3: "newyork me 5 din ka stay hai, 2 feb 2027 se"
    const real3 = fakeProvider({ extraction: { days: 5, departureDate: "2027-02-02" }, intent: "provide_trip_details" });
    const o3 = new TravelEmployeeLlmOrchestrator(real3, config, o2.lastEntities, o2.lastMemory);
    await o3.complete({ messages: [{ role: "user", content: "newyork me 5 din ka stay hai, 2 feb 2027 se" }], tools });
    expect(o3.lastEntities.days).toBe(5);

    // Turn 4: "bhai multileg hai" — a pure correction, no new route. Must acknowledge the CONNECTED journey
    // (Delhi -> London -> New York) without restarting budget/detail collection.
    const real4 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o4 = new TravelEmployeeLlmOrchestrator(real4, config, o3.lastEntities, o3.lastMemory);
    const result4 = await o4.complete({ messages: [{ role: "user", content: "bhai multileg hai" }], tools });
    expect(result4.content).toMatch(/multi-city|connected/i);
    expect(o4.journey?.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Delhi->London"]);
    // Not restarted: the New York leg's already-collected 5-day stay must still be there.
    expect(o4.lastEntities.days).toBe(5);
    expect(o4.lastEntities.destinationCity).toBe("New York");

    // Turn 5: "10000usd" — a budget CONSTRAINT, not a route change.
    const real5 = fakeProvider({ extraction: { budget: 10000, budgetCurrency: "USD" }, intent: "provide_trip_details" });
    const o5 = new TravelEmployeeLlmOrchestrator(real5, config, o4.lastEntities, o4.lastMemory);
    await o5.complete({ messages: [{ role: "user", content: "10000usd" }], tools });
    expect(o5.lastEntities.budget).toBe(10000);
    expect(o5.journey?.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Delhi->London"]);

    // Turn 6: bare Hinglish "ji" — the reported bug: this used to search/recommend ONLY the active
    // (New York) leg. It must now cover BOTH Delhi->London and London->New York.
    const real6 = fakeProvider({ extraction: {}, intent: "confirm_plan" });
    const o6 = new TravelEmployeeLlmOrchestrator(real6, config, o5.lastEntities, o5.lastMemory);
    const result6 = await o6.complete({ messages: [{ role: "user", content: "ji" }], tools });
    expect(result6.content).toMatch(/Delhi.*London/is);
    expect(result6.content).toMatch(/London.*New York/is);
    expect(result6.content).toMatch(/Leg 1/);
    expect(result6.content).toMatch(/Leg 2/);
  });
});

describe("route-relationship AMBIGUOUS end-to-end: ask rather than guess, and a bare 'ji' must never resolve it", () => {
  const delhiTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Rahul",
    originCity: "Delhi",
    destinationCity: "Delhi",
    travelMonth: "March",
    days: 5,
    adults: 2
  };
  const tools = [{ name: "travel.search_flights", description: "", inputSchema: {} }];

  it("asks 'same trip or separate trip', re-asks (never guesses) on a bare 'ji', then resolves correctly on an explicit answer", async () => {
    // Turn 1: a route that neither continues from the confirmed destination (Delhi) nor returns home (Delhi)
    // — genuinely ambiguous, must ask rather than silently pick a side.
    const real1 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, delhiTrip);
    const result1 = await o1.complete({ messages: [{ role: "user", content: "Tokyo to London" }], tools });
    expect(result1.content).toMatch(/same trip|separate trip/i);
    expect(o1.lastMemory.pendingRouteClarification).not.toBeNull();
    expect(o1.journey).toBeNull();

    // Turn 2: a bare Hinglish affirmative — must NOT be guessed as resolving the ambiguity either way.
    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    const result2 = await o2.complete({ messages: [{ role: "user", content: "ji" }], tools });
    expect(result2.content).toMatch(/same trip|separate trip/i);
    expect(o2.lastMemory.pendingRouteClarification).not.toBeNull();
    expect(o2.journey).toBeNull();

    // Turn 3: an explicit "same trip" answer resolves it as an extension of the existing Delhi trip.
    const real3 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o3 = new TravelEmployeeLlmOrchestrator(real3, config, o2.lastEntities, o2.lastMemory);
    await o3.complete({ messages: [{ role: "user", content: "same trip please" }], tools });
    expect(o3.lastMemory.pendingRouteClarification).toBeNull();
    expect(o3.journey?.legs).toHaveLength(1);
    expect(o3.journey?.legs[0]).toMatchObject({ origin: "Delhi", destination: "Delhi" });
    expect(o3.lastEntities.originCity).toBe("Tokyo");
    expect(o3.lastEntities.destinationCity).toBe("London");
  });

  it("an explicit 'separate trip' answer starts a fresh trip instead of extending the journey", async () => {
    const real1 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o1 = new TravelEmployeeLlmOrchestrator(real1, config, delhiTrip);
    await o1.complete({ messages: [{ role: "user", content: "Tokyo to London" }], tools });

    const real2 = fakeProvider({ extraction: {}, intent: "provide_trip_details" });
    const o2 = new TravelEmployeeLlmOrchestrator(real2, config, o1.lastEntities, o1.lastMemory);
    await o2.complete({ messages: [{ role: "user", content: "separate trip" }], tools });
    expect(o2.lastMemory.pendingRouteClarification).toBeNull();
    expect(o2.journey?.legs ?? []).toHaveLength(0);
    expect(o2.lastEntities.originCity).toBe("Tokyo");
    expect(o2.lastEntities.destinationCity).toBe("London");
    expect(o2.lastEntities.customerName).toBe("Rahul");
  });
});
