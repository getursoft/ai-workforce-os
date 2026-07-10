import { describe, expect, it } from "vitest";
import type { Clock } from "../../application/ports/clock";
import { SystemClock } from "./system-clock";

class FixedClock implements Clock {
  constructor(private readonly fixedTime: Date) {}

  now(): Date {
    return new Date(this.fixedTime);
  }
}

describe("Clock", () => {
  it("returns a Date from the system clock", () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });

  it("supports deterministic fixed clocks through the port", () => {
    const fixed = new Date("2026-07-10T12:00:00.000Z");
    const clock: Clock = new FixedClock(fixed);

    expect(clock.now()).toEqual(fixed);
    expect(clock.now()).not.toBe(fixed);
  });
});
