import { describe, expect, it } from "vitest";
import { handoffPresentation } from "./receptionist.service";

// Travel Booking Closure Pass — Phase 14/16/19: channel-aware handoff presentation. WEB already shows a
// visual "Connected to X" indicator, so the text-level announcement/prefix is redundant there; WHATSAPP
// and VOICE have no such indicator and still get a short spoken-style acknowledgement, but only on the
// turn that actually starts the handoff — never repeated on every follow-up turn, on any channel.
describe("handoffPresentation", () => {
  it("WEB: omits the connection announcement on a new handoff (the UI indicator already shows it)", () => {
    const result = handoffPresentation("WEB", "Travel Employee", "When would you like to travel?", true);
    expect(result).toBe("When would you like to travel?");
    expect(result).not.toContain("I'll connect you with");
    expect(result).not.toContain("Travel Employee:");
  });

  it("WHATSAPP: keeps a short acknowledgement on a new handoff (no visual indicator exists there)", () => {
    const result = handoffPresentation("WHATSAPP", "Travel Employee", "When would you like to travel?", true);
    expect(result).toContain("Travel Employee");
    expect(result).toContain("When would you like to travel?");
    // Natural, not the old robotic "I'll connect you with Travel Employee." announcement.
    expect(result).not.toContain("I'll connect you with Travel Employee.");
  });

  it("VOICE: keeps a short acknowledgement on a new handoff, same as WhatsApp", () => {
    const result = handoffPresentation("VOICE", "Travel Employee", "When would you like to travel?", true);
    expect(result).toContain("Travel Employee");
    expect(result).toContain("When would you like to travel?");
  });

  it("every channel: never repeats the announcement/prefix on a CONTINUE_HANDOFF turn", () => {
    for (const channel of ["WEB", "WHATSAPP", "VOICE"] as const) {
      const result = handoffPresentation(channel, "Travel Employee", "Got it, thanks!", false);
      expect(result).toBe("Got it, thanks!");
      expect(result).not.toContain("Travel Employee");
    }
  });

  // Sprint 6.3 — Part 5/11: every specialist response passes through this function, so it's the shared
  // choke point for the channel-response policy (conversational-response-policy.ts) — verified in
  // integration here, not just in that module's own unit tests.
  it("VOICE: converts a bulleted specialist response into plain speakable prose", () => {
    const result = handoffPresentation(
      "VOICE",
      "Travel Employee",
      "Here are three simulated package options:\n\n• Option 1 — Value\n• Option 2 — Recommended",
      false
    );
    expect(result).not.toMatch(/[•]/);
    expect(result).toContain("Option 1");
  });

  it("every channel: strips a stray 'Debug'/'Travel Employee:' leak from a specialist response", () => {
    for (const channel of ["WEB", "WHATSAPP", "VOICE"] as const) {
      const result = handoffPresentation(
        channel,
        "Travel Employee",
        "Travel Employee: Your booking is confirmed!\nDebug",
        false
      );
      expect(result).not.toContain("Travel Employee:");
      expect(result).not.toMatch(/^Debug$/m);
      expect(result).toContain("Your booking is confirmed!");
    }
  });
});
