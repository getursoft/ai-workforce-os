import { describe, expect, it } from "vitest";
import { extractMemories, looksLikeMemoryDirective } from "./memory.extractor";

describe("memory extraction rules", () => {
  it("remembers a vegetarian preference", () => {
    const memories = extractMemories("Remember that I prefer vegetarian food.");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.key).toBe("food.preference");
    expect(memories[0]?.value).toBe("Vegetarian");
    expect(memories[0]?.importance).toBe("HIGH");
    expect(memories[0]?.confidence).toBe(0.99);
    expect(memories[0]?.source).toBe("RULE_EXTRACTION");
    expect(memories[0]?.scope).toBe("USER");
  });

  it("remembers 'i am vegetarian'", () => {
    const memories = extractMemories("I am vegetarian.");
    expect(memories.some((memory) => memory.key === "food.preference")).toBe(true);
  });

  it("remembers a preferred airline from several phrasings", () => {
    for (const text of [
      "My preferred airline is Emirates",
      "Remember I prefer Emirates",
      "I fly with Emirates"
    ]) {
      const memories = extractMemories(text);
      const airline = memories.find((memory) => memory.key === "preferred.airline");
      expect(airline).toBeDefined();
      expect(airline?.value).toBe("Emirates");
    }
  });

  it("remembers a seat preference", () => {
    const memories = extractMemories("My seat preference is window.");
    expect(memories[0]?.key).toBe("seat.preference");
    expect(memories[0]?.value).toBe("Window Seat");
  });

  it("remembers business-class travel", () => {
    const memories = extractMemories("I always travel Business Class.");
    expect(memories[0]?.key).toBe("travel.cabin");
    expect(memories[0]?.value).toBe("Business Class");
  });

  it("remembers a city of residence", () => {
    const memories = extractMemories("I live in Bangalore.");
    expect(memories[0]?.key).toBe("location.city");
    expect(memories[0]?.value).toBe("Bangalore");
  });

  it("remembers a passport expiry (flagged sensitive)", () => {
    const memories = extractMemories("My passport expires in 2029.");
    expect(memories[0]?.key).toBe("travel.passport.expiry");
    expect(memories[0]?.value).toBe("2029");
    expect(memories[0]?.metadata).toMatchObject({ sensitive: true });
  });

  it("remembers a GST number (flagged sensitive)", () => {
    const memories = extractMemories("My GST number is 27ABCDE1234F1Z5");
    expect(memories[0]?.key).toBe("tax.gst");
    expect(memories[0]?.value).toBe("27ABCDE1234F1Z5");
    expect(memories[0]?.metadata).toMatchObject({ sensitive: true });
  });

  it("remembers a contact phone number", () => {
    const memories = extractMemories("My phone number is +91 98765 43210");
    expect(memories.some((memory) => memory.key === "contact.phone")).toBe(true);
  });

  it("remembers a preferred language and payment method", () => {
    expect(extractMemories("My preferred language is Hindi.")[0]?.key).toBe("preferred.language");
    expect(extractMemories("My preferred payment method is UPI.")[0]?.key).toBe("payment.preferred");
  });

  it("stores ephemeral 'hotel today' with an end-of-day expiry (CONVERSATION scope)", () => {
    const memories = extractMemories("My hotel today is Grand Palace.");
    expect(memories[0]?.key).toBe("travel.current.hotel");
    expect(memories[0]?.scope).toBe("CONVERSATION");
    expect(memories[0]?.expiresAt).toBeInstanceOf(Date);
    const expiresAt = memories[0]?.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a precise rule wins over the generic fallback", () => {
    const memories = extractMemories("Remember that I prefer Emirates.");
    expect(memories.filter((memory) => memory.key === "preferred.airline")).toHaveLength(1);
    expect(memories[0]?.key).toBe("preferred.airline");
  });

  it("extracts nothing from ordinary conversation", () => {
    expect(extractMemories("What is the weather like in Delhi?")).toHaveLength(0);
    expect(extractMemories("")).toHaveLength(0);
  });

  it("detects explicit memory directives", () => {
    expect(looksLikeMemoryDirective("Remember that I prefer vegetarian food.")).toBe(true);
    expect(looksLikeMemoryDirective("My preferred airline is Emirates.")).toBe(true);
    expect(looksLikeMemoryDirective("Tell me about Dubai.")).toBe(false);
  });
});
