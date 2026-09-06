import { describe, expect, it } from "vitest";
import { formatDuration, statusTone } from "./voice-call-pages";

describe("formatDuration", () => {
  it("formats seconds as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(60)).toBe("1:00");
    expect(formatDuration(125)).toBe("2:05");
  });
  it("renders an em dash when the call has no measurable duration yet", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("statusTone", () => {
  it.each([
    ["ENDED", "success"],
    ["FAILED", "danger"],
    ["ACTIVE", "warning"],
    ["INTERRUPTED", "warning"],
    ["RINGING", "neutral"],
    ["CREATED", "neutral"]
  ])("maps %s to the %s badge tone", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });
});
