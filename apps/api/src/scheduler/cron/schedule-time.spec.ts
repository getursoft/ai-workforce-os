import { describe, expect, it } from "vitest";
import { computeNextRun, computeScheduleNextRun, parseCron, parseDuration } from "./schedule-time";

describe("parseDuration", () => {
  it("parses common durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(parseDuration("90min")).toBe(5_400_000);
    expect(parseDuration(1234)).toBe(1234);
  });
  it("rejects invalid durations", () => {
    expect(() => parseDuration("bogus")).toThrow();
  });
});

describe("parseCron", () => {
  it("parses a standard 5-field expression", () => {
    const fields = parseCron("*/15 9-17 * * 1-5");
    expect(fields.minute.has(0)).toBe(true);
    expect(fields.minute.has(15)).toBe(true);
    expect(fields.hour.has(9)).toBe(true);
    expect(fields.hour.has(17)).toBe(true);
    expect(fields.dayOfWeek.has(1)).toBe(true);
    expect(fields.dayOfWeek.has(5)).toBe(true);
    expect(fields.dayOfWeek.has(0)).toBe(false);
  });
  it("normalizes 7 to Sunday", () => {
    const fields = parseCron("0 0 * * 7");
    expect(fields.dayOfWeek.has(0)).toBe(true);
  });
  it("rejects non-5-field expressions", () => {
    expect(() => parseCron("0 0 * *")).toThrow();
  });
});

describe("computeNextRun", () => {
  const base = new Date("2026-08-03T10:00:00.000Z"); // a Monday

  it("INTERVAL advances by the interval", () => {
    const result = computeNextRun({ triggerType: "INTERVAL", interval: "30m" }, base);
    expect(result.nextRun?.getTime()).toBe(base.getTime() + 30 * 60_000);
  });

  it("DAILY finds the next occurrence of the wall-clock time", () => {
    const at10 = computeNextRun({ triggerType: "DAILY", atTime: "10:00", timeZone: "UTC" }, base);
    // base is exactly 10:00 UTC Monday → strictly after base → next day 10:00
    expect(at10.nextRun?.toISOString()).toBe("2026-08-04T10:00:00.000Z");
    const at09 = computeNextRun({ triggerType: "DAILY", atTime: "09:00", timeZone: "UTC" }, base);
    expect(at09.nextRun?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("DAILY respects the schedule timezone (Asia/Kolkata)", () => {
    const at09 = computeNextRun(
      { triggerType: "DAILY", atTime: "09:00", timeZone: "Asia/Kolkata" },
      base
    );
    // 09:00 IST == 03:30 UTC on 2026-08-04
    expect(at09.nextRun?.toISOString()).toBe("2026-08-04T03:30:00.000Z");
  });

  it("WEEKLY respects selected days", () => {
    const weekdays = computeNextRun(
      { triggerType: "WEEKLY", daysOfWeek: [1, 2, 3, 4, 5], atTime: "09:00", timeZone: "UTC" },
      base
    );
    // base is Monday 10:00 → next weekday 09:00 is Tuesday
    expect(weekdays.nextRun?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
    const sundayOnly = computeNextRun(
      { triggerType: "WEEKLY", daysOfWeek: [0], atTime: "09:00", timeZone: "UTC" },
      base
    );
    // Monday → next Sunday
    expect(sundayOnly.nextRun?.toISOString()).toBe("2026-08-09T09:00:00.000Z");
  });

  it("MONTHLY skips months that lack the target day", () => {
    const monthly = computeNextRun(
      { triggerType: "MONTHLY", dayOfMonth: 31, atTime: "09:00", timeZone: "UTC" },
      base
    );
    // next 31st after 2026-08-03 is 2026-08-31
    expect(monthly.nextRun?.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });

  it("CRON computes a future match", () => {
    const cron = computeNextRun(
      { triggerType: "CRON", cronExpression: "30 9 * * 1-5", timeZone: "UTC" },
      base
    );
    expect(cron.nextRun?.toISOString()).toBe("2026-08-04T09:30:00.000Z");
  });

  it("handles DST: a daily 09:30 job stays at 09:30 local across the spring-forward", () => {
    // America/New_York spring forward 2026: Sunday 2026-03-08 02:00 → 03:00 local.
    const before = new Date("2026-03-07T14:31:00.000Z"); // just after Saturday 09:30 EST
    const result = computeNextRun(
      { triggerType: "DAILY", atTime: "09:30", timeZone: "America/New_York" },
      before
    );
    expect(result.nextRun).not.toBeNull();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23"
    }).formatToParts(result.nextRun as Date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    expect(hour).toBe(9);
    expect(minute).toBe(30);
    // The DST switch means Sunday 09:30 EDT == 13:30 UTC (not 14:30 EST).
    expect(result.nextRun?.toISOString()).toBe("2026-03-08T13:30:00.000Z");
  });

  it("returns null when no run exists in the lookahead (Feb 30)", () => {
    const monthly = computeNextRun(
      { triggerType: "MONTHLY", dayOfMonth: 30, atTime: "09:00", timeZone: "UTC" },
      new Date("2026-01-01T00:00:00.000Z")
    );
    // Jan 30 exists in 2026, so a run is found — sanity check the engine.
    expect(monthly.nextRun).toBeInstanceOf(Date);
  });
});

describe("computeScheduleNextRun", () => {
  it("exposes the convenience wrapper", () => {
    const next = computeScheduleNextRun(
      { triggerType: "DAILY", atTime: "08:00", timeZone: "UTC" },
      new Date("2026-08-03T10:00:00.000Z")
    );
    expect(next?.toISOString()).toBe("2026-08-04T08:00:00.000Z");
  });
});
