import { describe, expect, it } from "vitest";
import { getLocalResponse } from "@/lib/chatbot-local-responder";
import { FALLBACK_ANSWER } from "@/content/chatbot-knowledge";

describe("getLocalResponse", () => {
  it("matches a known question to its knowledge base entry", () => {
    const result = getLocalResponse("What is an AI employee?");
    expect(result.message).toMatch(/role-based AI worker/i);
    expect(result.actions?.[0]?.href).toBe("/meet-ai-employees");
  });

  it("returns the exact fallback answer for unrelated questions", () => {
    const result = getLocalResponse("What is the airspeed velocity of an unladen swallow?");
    expect(result.message).toBe(FALLBACK_ANSWER);
  });

  it("never claims SOC 2, ISO 27001 or GDPR certification", () => {
    const result = getLocalResponse("Are you SOC 2 certified?");
    expect(result.message).not.toMatch(/we are (SOC 2|ISO 27001|GDPR) certified/i);
    expect(result.message).toMatch(/designed to support enterprise security requirements/i);
  });

  it("returns the fallback answer for an empty message", () => {
    const result = getLocalResponse("   ");
    expect(result.message).toBe(FALLBACK_ANSWER);
  });
});
