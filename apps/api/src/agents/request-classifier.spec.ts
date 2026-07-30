import { describe, expect, it } from "vitest";
import { classifyRequestIntent, isKnowledgeEligible } from "./request-classifier";

const TRAVEL = { isTravelEmployee: true };
const NON_TRAVEL = { isTravelEmployee: false };

describe("classifyRequestIntent (central request classifier)", () => {
  it.each([
    "i want to travel delhi to mumbai on 10 dec 26",
    "plan the trip",
    "delhi se mumbai jana hai",
    "mujhe london jana hai"
  ])("classifies %j as TRAVEL_PLANNING for the Travel Employee", (text) => {
    expect(classifyRequestIntent(text, TRAVEL)).toBe("TRAVEL_PLANNING");
  });

  it.each(["10 december", "5 days", "2 adults"])(
    "classifies the bare slot fragment %j as SLOT_UPDATE for the Travel Employee",
    (text) => {
      expect(classifyRequestIntent(text, TRAVEL)).toBe("SLOT_UPDATE");
    }
  );

  it.each([
    "4 rat ke liye jana hai 3 adult 1 kid",
    "15 August",
    "Dubai me 5 din",
    "New York me 3 din",
    "5 log",
    "sab piche bataya hai",
    "mera route kya hai"
  ])("routes trip-state-bearing message %j before Knowledge/RAG", (text) => {
    const intent = classifyRequestIntent(text, TRAVEL);
    expect(intent).not.toBe("KNOWLEDGE_QUERY");
    expect(isKnowledgeEligible(intent)).toBe(false);
  });

  it.each([
    "what is the cancellation policy",
    "where is kids policy",
    "infant fare",
    "can I cancel my booking",
    "what are infant rules"
  ])("classifies %j as KNOWLEDGE_QUERY for the Travel Employee", (text) => {
    expect(classifyRequestIntent(text, TRAVEL)).toBe("KNOWLEDGE_QUERY");
  });

  it("classifies an ordinary knowledge question as KNOWLEDGE_QUERY for a non-travel employee too", () => {
    expect(classifyRequestIntent("what is the cancellation policy", NON_TRAVEL)).toBe("KNOWLEDGE_QUERY");
  });

  it("never lets a travel-planning message with incidental policy vocabulary be misread as a knowledge query", () => {
    // Contains "travel" (which also appears in "travel policy"), but the explicit city route must win.
    expect(classifyRequestIntent("i want to travel delhi to mumbai on 10 dec 26", TRAVEL)).not.toBe(
      "KNOWLEDGE_QUERY"
    );
  });

  it.each(["book the flight", "search hotels", "generate a lead", "submit this enquiry"])(
    "classifies an explicit action command (%j) as TASK_EXECUTION, distinct from a plain planning statement",
    (text) => {
      expect(classifyRequestIntent(text, TRAVEL)).toBe("TASK_EXECUTION");
    }
  );

  // Regression: "Create itinerary" already routed correctly (ITINERARY_ACTION_PATTERN), but "Estimate
  // budget", "Suggest hotels", and "Suggest flights" fell through every `classifyPlanningAction` pattern
  // (no destination/journey/"trip" phrasing) and landed on `looksLikeKnowledgeQuery`'s generic topic-term
  // check — "hotels"/"flights" are travel-domain nouns that incidentally overlap the knowledge module's
  // TERM_GROUPS, so these got answered from RAG instead of the trip-planning flow, silently discarding
  // everything already captured in TripState. See GENERIC_TRAVEL_ACTION_PATTERN.
  it.each([
    "Create itinerary",
    "Estimate budget",
    "estimate my trip budget",
    "Suggest hotels",
    "suggest some hotels for me",
    "Suggest flights",
    "suggest good flights"
  ])("never routes %j to Knowledge/RAG — always TASK_EXECUTION for the Travel Employee", (text) => {
    const intent = classifyRequestIntent(text, TRAVEL);
    expect(intent).toBe("TASK_EXECUTION");
    expect(isKnowledgeEligible(intent)).toBe(false);
  });

  it("a genuine policy question naming the same nouns (hotel/flight) still reaches the knowledge bypass", () => {
    expect(classifyRequestIntent("what is your hotel cancellation policy", TRAVEL)).toBe("KNOWLEDGE_QUERY");
  });

  it.each(["yes", "confirm", "sounds good", "let's book it", "go ahead"])(
    "classifies an explicit go-ahead (%j) as CONFIRMATION",
    (text) => {
      expect(classifyRequestIntent(text, TRAVEL)).toBe("CONFIRMATION");
    }
  );

  it.each(["change destination to Paris", "actually, make it September", "instead go with Mumbai", "update budget to 12000"])(
    "classifies an explicit correction utterance (%j) as CORRECTION",
    (text) => {
      expect(classifyRequestIntent(text, TRAVEL)).toBe("CORRECTION");
    }
  );

  it("classifies ordinary small talk as GENERAL_CHAT", () => {
    expect(classifyRequestIntent("good morning, how are you?", TRAVEL)).toBe("GENERAL_CHAT");
    expect(classifyRequestIntent("good morning, how are you?", NON_TRAVEL)).toBe("GENERAL_CHAT");
  });

  it("classifies empty/whitespace input as UNKNOWN", () => {
    expect(classifyRequestIntent("", TRAVEL)).toBe("UNKNOWN");
    expect(classifyRequestIntent("   ", NON_TRAVEL)).toBe("UNKNOWN");
  });

  it("a bare slot fragment for a non-travel employee is not treated as a domain slot update", () => {
    expect(classifyRequestIntent("5 days", NON_TRAVEL)).not.toBe("SLOT_UPDATE");
  });
});

describe("isKnowledgeEligible", () => {
  it("is true only for KNOWLEDGE_QUERY", () => {
    expect(isKnowledgeEligible("KNOWLEDGE_QUERY")).toBe(true);
    for (const other of [
      "TASK_EXECUTION",
      "TRAVEL_PLANNING",
      "SLOT_UPDATE",
      "GENERAL_CHAT",
      "CONFIRMATION",
      "CORRECTION",
      "UNKNOWN"
    ] as const)
      expect(isKnowledgeEligible(other)).toBe(false);
  });
});
