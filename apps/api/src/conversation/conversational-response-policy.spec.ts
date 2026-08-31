import { describe, expect, it } from "vitest";
import { composeChannelResponse, stripDebugWording, toVoiceSafeText } from "./conversational-response-policy";

describe("stripDebugWording", () => {
  it("removes a 'Connected to X' line", () => {
    expect(stripDebugWording("Connected to Travel Employee\nWhere would you like to go?")).toBe(
      "Where would you like to go?"
    );
  });

  it("removes a leading 'Travel Employee:' prefix line", () => {
    expect(stripDebugWording("Travel Employee: Your booking is confirmed!")).toBe("Your booking is confirmed!");
  });

  it("removes 'Debug', 'handoff ID', 'routing confidence', 'workflow execution', 'installation ID' lines", () => {
    const raw = [
      "Your booking is confirmed!",
      "Debug",
      "handoff ID: abc-123",
      "routing confidence: 0.92",
      "workflow execution id: exec-1",
      "installation ID: plugin-1"
    ].join("\n");
    expect(stripDebugWording(raw)).toBe("Your booking is confirmed!");
  });

  it("never strips ordinary transactional 'Label: value' facts", () => {
    const raw = [
      "Please confirm your simulated booking:",
      "PNR: WSTVSQ",
      "Booking Reference: RRAUHV",
      "Total: AED 26,203",
      "Flight: Qatar Airways QA540 (Economy Flex)"
    ].join("\n");
    expect(stripDebugWording(raw)).toBe(raw);
  });

  it("is a no-op on a message with nothing to strip", () => {
    expect(stripDebugWording("Where would you like to travel to?")).toBe("Where would you like to travel to?");
  });
});

describe("toVoiceSafeText", () => {
  it("strips bullet markers and joins lines into prose", () => {
    const raw = "I can help you:\n• Ask about leave policy\n• Start onboarding";
    const voice = toVoiceSafeText(raw);
    expect(voice).not.toMatch(/[•]/);
    expect(voice).toContain("Ask about leave policy");
    expect(voice).toContain("Start onboarding");
  });

  it("strips numbered-list markers", () => {
    const voice = toVoiceSafeText("Pick one:\n1. Value\n2. Recommended\n3. Premium");
    expect(voice).not.toMatch(/^\d[.)]/m);
    expect(voice).toContain("Value");
  });

  it("strips markdown headings and emphasis", () => {
    const voice = toVoiceSafeText("# Booking confirmed\n**Total:** AED 26,203, _simulated_ ticket");
    expect(voice).not.toMatch(/[#*_`]/);
    expect(voice).toContain("Total:");
    expect(voice).toContain("simulated");
  });

  it("strips bare URLs", () => {
    const voice = toVoiceSafeText("Download it at https://example.com/ticket.pdf now");
    expect(voice).not.toMatch(/https?:\/\//);
  });

  it("collapses multiple lines into a single spoken-style string with no raw newlines", () => {
    const voice = toVoiceSafeText("Line one\nLine two\nLine three");
    expect(voice).not.toContain("\n");
    expect(voice).toContain("Line one");
    expect(voice).toContain("Line three");
  });
});

describe("composeChannelResponse", () => {
  it("WEB: strips debug wording only, keeps rich formatting", () => {
    const result = composeChannelResponse("Debug\n• Option 1\n• Option 2", "WEB");
    expect(result).toEqual({ message: "• Option 1\n• Option 2", channel: "WEB" });
  });

  it("WHATSAPP: strips debug wording only, same as WEB by default", () => {
    const result = composeChannelResponse("Connected to Travel Employee\nHello!", "WHATSAPP");
    expect(result.message).toBe("Hello!");
    expect(result.channel).toBe("WHATSAPP");
  });

  it("VOICE: strips debug wording AND converts to voice-safe prose", () => {
    const result = composeChannelResponse("Debug\n• Option 1\n• Option 2", "VOICE");
    expect(result.message).not.toMatch(/[•]/);
    expect(result.message).not.toMatch(/Debug/);
    expect(result.channel).toBe("VOICE");
  });

  it("passes through optional contract fields untouched", () => {
    const result = composeChannelResponse("Hi", "WEB", {
      requiresUserInput: true,
      attachments: [{ type: "PDF_TICKET" }]
    });
    expect(result.requiresUserInput).toBe(true);
    expect(result.attachments).toEqual([{ type: "PDF_TICKET" }]);
  });
});
