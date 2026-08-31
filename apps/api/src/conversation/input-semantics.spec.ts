import { describe, expect, it } from "vitest";
import { classifyUserInput } from "./input-semantics";

const noPending = { hasPendingQuestion: false };
const pending = { hasPendingQuestion: true };

describe("classifyUserInput", () => {
  describe("FAREWELL", () => {
    it.each(["bye", "goodbye", "that's all", "nothing else", "no more questions"])(
      '"%s" is a farewell',
      (text) => {
        expect(classifyUserInput(text, noPending).semantic).toBe("FAREWELL");
      }
    );
  });

  describe("REJECTION", () => {
    it.each(["no", "no thanks", "not now", "maybe later", "don't book it", "I don't want that option"])(
      '"%s" is a rejection',
      (text) => {
        expect(classifyUserInput(text, noPending).semantic).toBe("REJECTION");
      }
    );

    it("declining an option after an explicit booking question does not close the conversation", () => {
      const result = classifyUserInput("No.", pending);
      expect(result.semantic).toBe("REJECTION");
    });
  });

  describe("CORRECTION", () => {
    it.each([
      "Actually make it 3 adults",
      "Not Dubai, Singapore",
      "No, make the destination Singapore instead",
      "Change the budget to 15,000 AED.",
      "Sorry, I meant October",
      "Make that 7 nights",
      "Actually 3 adults kar do.",
      "Dubai nahi, Singapore kar do.",
      "Budget 15000 AED kar do."
    ])('"%s" is a correction', (text) => {
      expect(classifyUserInput(text, noPending).semantic).toBe("CORRECTION");
    });
  });

  describe("pending question does not override an obvious correction/pivot", () => {
    it('"Actually change the destination to Singapore." while budget is pending is still a CORRECTION', () => {
      const result = classifyUserInput("Actually change the destination to Singapore.", pending);
      expect(result.semantic).toBe("CORRECTION");
    });

    it('"I need HR help instead." while travellers is pending is a DOMAIN_PIVOT, not an ANSWER', () => {
      const result = classifyUserInput("I need HR help instead.", pending);
      expect(result.semantic).toBe("DOMAIN_PIVOT");
    });
  });

  describe("ACKNOWLEDGEMENT", () => {
    it.each(["okay", "ok", "sure", "great", "perfect", "sounds good", "fine", "got it", "thanks", "thank you", "looks good"])(
      '"%s" is an acknowledgement',
      (text) => {
        expect(classifyUserInput(text, noPending).semantic).toBe("ACKNOWLEDGEMENT");
      }
    );
  });

  describe("ACTION", () => {
    it.each(["book it", "show options", "share pdf", "go ahead"])('"%s" is an action', (text) => {
      expect(classifyUserInput(text, noPending).semantic).toBe("ACTION");
    });
  });

  describe("ANSWER vs INFORMATION", () => {
    it("a bare number answers a pending numeric question", () => {
      expect(classifyUserInput("3", pending).semantic).toBe("ANSWER");
    });

    it("unprompted multi-slot information is INFORMATION, not ANSWER, with no pending question", () => {
      const result = classifyUserInput("I need Dubai next month for five nights", noPending);
      expect(result.semantic).toBe("INFORMATION");
    });
  });

  describe("UNKNOWN safety default", () => {
    it("never mutates state on an unrecognizable message", () => {
      expect(classifyUserInput("hmm", noPending).semantic).toBe("UNKNOWN");
    });

    it("empty text is UNKNOWN", () => {
      expect(classifyUserInput("   ", noPending).semantic).toBe("UNKNOWN");
    });
  });
});
