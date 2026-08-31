import { describe, it, expect, beforeEach } from "vitest";
import { PendingInputQuestionService } from "./pending-input-question.service";
import type { PendingInputCode } from "./input-decision.dto";

describe("PendingInputQuestionService", () => {
  let service: PendingInputQuestionService;

  beforeEach(() => {
    service = new PendingInputQuestionService();
  });

  describe("English questions", () => {
    it("should generate origin question", () => {
      const question = service.generateQuestion("ORIGIN", "ENGLISH");
      expect(question).toBe("Where are you traveling from?");
    });

    it("should generate destination question", () => {
      const question = service.generateQuestion("DESTINATION", "ENGLISH");
      expect(question).toBe("Where are you traveling to?");
    });

    it("should generate departure date question", () => {
      const question = service.generateQuestion("DEPARTURE_DATE", "ENGLISH");
      expect(question).toBe("When are you planning to travel?");
    });

    it("should generate travel year question", () => {
      const question = service.generateQuestion("TRAVEL_YEAR", "ENGLISH");
      expect(question).toBe("What year?");
    });

    it("should generate travellers count question", () => {
      const question = service.generateQuestion("TRAVELLERS", "ENGLISH");
      expect(question).toBe("How many people will be traveling?");
    });

    it("should generate traveller composition question", () => {
      const question = service.generateQuestion("TRAVELLER_COMPOSITION", "ENGLISH");
      expect(question).toContain("breakdown");
    });

    it("should generate duration question", () => {
      const question = service.generateQuestion("DURATION", "ENGLISH");
      expect(question).toContain("How long");
    });

    it("should handle null pending input", () => {
      const question = service.generateQuestion(null, "ENGLISH");
      expect(question).toContain("complete");
    });
  });

  describe("Language support", () => {
    it("should generate Spanish questions", () => {
      const origin = service.generateQuestion("ORIGIN", "SPANISH");
      expect(origin).toBe("¿De dónde viaja?");
    });

    it("should generate French questions", () => {
      const origin = service.generateQuestion("ORIGIN", "FRENCH");
      expect(origin).toBe("D'où voyagez-vous?");
    });

    it("should generate German questions", () => {
      const origin = service.generateQuestion("ORIGIN", "GERMAN");
      expect(origin).toBe("Von wo reisen Sie?");
    });

    it("should fallback to English for unknown language", () => {
      const origin = service.generateQuestion("ORIGIN", "UNKNOWN_LANGUAGE");
      expect(origin).toBe("Where are you traveling from?");
    });

    it("should handle case insensitivity", () => {
      const question1 = service.generateQuestion("ORIGIN", "english");
      const question2 = service.generateQuestion("ORIGIN", "ENGLISH");
      expect(question1).toBe(question2);
    });
  });

  describe("Brief prompts", () => {
    it("should generate brief origin prompt", () => {
      const prompt = service.generateBriefPrompt("ORIGIN");
      expect(prompt).toBe("Where are you traveling from?");
    });

    it("should generate brief destination prompt", () => {
      const prompt = service.generateBriefPrompt("DESTINATION");
      expect(prompt).toBe("Where are you traveling to?");
    });

    it("should generate brief travel year prompt", () => {
      const prompt = service.generateBriefPrompt("TRAVEL_YEAR");
      expect(prompt).toBe("What year?");
    });

    it("should return empty string for null", () => {
      const prompt = service.generateBriefPrompt(null);
      expect(prompt).toBe("");
    });

    it("should handle unknown field gracefully", () => {
      const prompt = service.generateBriefPrompt("UNKNOWN_FIELD" as unknown as PendingInputCode);
      expect(prompt).toBe("Could you tell me a bit more?");
    });
  });

  describe("All pending input types", () => {
    const allInputTypes = [
      "ORIGIN",
      "DESTINATION",
      "DEPARTURE_DATE",
      "TRAVEL_YEAR",
      "TRAVELLERS",
      "TRAVELLER_COMPOSITION",
      "DURATION"
    ] as const;

    it("should generate non-empty questions for all input types", () => {
      for (const inputType of allInputTypes) {
        const question = service.generateQuestion(inputType, "ENGLISH");
        expect(question).toBeTruthy();
        expect(question.length).toBeGreaterThan(0);
      }
    });

    it("should generate non-empty prompts for all input types", () => {
      for (const inputType of allInputTypes) {
        const prompt = service.generateBriefPrompt(inputType);
        expect(prompt).toBeTruthy();
        expect(prompt.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Language consistency", () => {
    it("Spanish translations should exist for all English questions", () => {
      const englishQuestions = [
        "ORIGIN",
        "DESTINATION",
        "DEPARTURE_DATE",
        "TRAVEL_YEAR",
        "TRAVELLERS",
        "TRAVELLER_COMPOSITION",
        "DURATION",
        "NO_PENDING_INPUT",
        "UNKNOWN_FIELD"
      ];

      for (const field of englishQuestions) {
        const englishQ = service.generateQuestion(field as unknown as PendingInputCode, "ENGLISH");
        const spanishQ = service.generateQuestion(field as unknown as PendingInputCode, "SPANISH");
        expect(spanishQ).toBeTruthy();
        expect(spanishQ).not.toBe(englishQ);
      }
    });

    it("should provide complete French translations", () => {
      const frenchQuestions = [
        "ORIGIN",
        "DESTINATION",
        "DEPARTURE_DATE",
        "TRAVEL_YEAR",
        "TRAVELLERS",
        "TRAVELLER_COMPOSITION",
        "DURATION"
      ];

      for (const field of frenchQuestions) {
        const frenchQ = service.generateQuestion(field as unknown as PendingInputCode, "FRENCH");
        expect(frenchQ).toBeTruthy();
        expect(frenchQ.length).toBeGreaterThan(0);
      }
    });
  });
});
