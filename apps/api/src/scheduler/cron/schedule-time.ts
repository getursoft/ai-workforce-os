/**
 * Sprint 4.8 — schedule → next-run computation.
 *
 * All scheduling math is done in wall-clock terms inside the schedule's IANA timezone, then converted
 * back to UTC for persistence. Because every candidate is compared against the ACTUAL wall-clock parts
 * in that timezone (via Intl.DateTimeFormat), Daylight Saving transitions are handled correctly: a daily
 * 09:30 job still fires at 09:30 local time whether the clocks sprang forward or fell back.
 */

export interface TimeZoneParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0-6 (0 = Sunday)
}

export function wallClockParts(utcDate: Date, timeZone: string): TimeZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(utcDate);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayText = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    weekday: weekdayIndex(weekdayText)
  };
}

function weekdayIndex(text: string): number {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[text] ?? 0;
}

/** Parses a human duration ("30s", "5m", "1h", "2d", "1w", "90min") into milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim().toLowerCase();
  const match = /^(\d+)\s*(ms|s|m|min|h|d|w)?$/.exec(text);
  if (!match) throw new Error(`INVALID_DURATION: ${value}`);
  const amountText = match[1];
  if (amountText === undefined) throw new Error(`INVALID_DURATION: ${value}`);
  const amount = Number(amountText);
  const unit = match[2] ?? "ms";
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) throw new Error(`INVALID_DURATION: ${value}`);
  return amount * multiplier;
}

/** Interval spec either as an explicit ms number or a "30s"/"5m"/"1h"/"2d"/"1w" string. */
export type IntervalSpec = number | string;

export interface RecurringScheduleSpec {
  triggerType: "CRON" | "INTERVAL" | "DAILY" | "WEEKLY" | "MONTHLY";
  cronExpression?: string | null;
  interval?: IntervalSpec | null;
  timeZone?: string;
  /** DAILY: HH:MM, or parsed from cronExpression when it is "M H * * *". */
  atTime?: string | null;
  /** WEEKLY: 0-6 (0=Sunday). */
  daysOfWeek?: number[];
  /** MONTHLY: day of month 1-31. */
  dayOfMonth?: number | null;
}

export interface ScheduleComputationResult {
  nextRun: Date | null;
}

const MINUTE_MS = 60_000;
const MAX_LOOKAHEAD_MINUTES = 3 * 366 * 24 * 60; // ~3 years of minutes — generous upper bound

/**
 * Computes the next run strictly after `from` for a recurring schedule, in the given timezone.
 * Returns null when no run can be found within the lookahead window (e.g. Feb 30 monthly).
 */
export function computeNextRun(spec: RecurringScheduleSpec, from: Date): ScheduleComputationResult {
  const timeZone = spec.timeZone?.trim() || "UTC";
  switch (spec.triggerType) {
    case "INTERVAL": {
      const intervalMs = spec.interval == null ? 0 : parseDuration(spec.interval);
      if (intervalMs <= 0) return { nextRun: null };
      return { nextRun: new Date(from.getTime() + intervalMs) };
    }
    case "DAILY":
      return dailyNextRun(spec.atTime ?? "09:00", timeZone, from);
    case "WEEKLY":
      return weeklyNextRun(
        spec.daysOfWeek ?? [1, 2, 3, 4, 5],
        spec.atTime ?? "09:00",
        timeZone,
        from
      );
    case "MONTHLY":
      return monthlyNextRun(spec.dayOfMonth ?? 1, spec.atTime ?? "09:00", timeZone, from);
    case "CRON": {
      if (!spec.cronExpression) return { nextRun: null };
      const fields = parseCron(spec.cronExpression);
      return cronNextRun(fields, timeZone, from);
    }
    default:
      return { nextRun: null };
  }
}

/** Parses a 5-field cron expression (minute hour day-of-month month day-of-week). */
export interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
}

function expandField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const segment of field.split(",")) {
    if (!segment) continue;
    if (segment === "*") {
      for (let value = min; value <= max; value += 1) result.add(value);
      continue;
    }
    let step = 1;
    let base = segment;
    if (segment.includes("/")) {
      const [range, stepText] = segment.split("/");
      base = range ?? segment;
      step = Number(stepText) || 1;
    }
    let start = min;
    let end = max;
    if (base.includes("-")) {
      const [startText, endText] = base.split("-");
      start = Number(startText);
      end = Number(endText);
    } else if (base !== "*") {
      start = Number(base);
      end = start;
    }
    for (let value = start; value <= end; value += step) result.add(value);
  }
  return result;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`INVALID_CRON_EXPRESSION: ${expression}`);
  const field0 = fields[0];
  const field1 = fields[1];
  const field2 = fields[2];
  const field3 = fields[3];
  const field4 = fields[4];
  if (
    field0 === undefined ||
    field1 === undefined ||
    field2 === undefined ||
    field3 === undefined ||
    field4 === undefined
  ) {
    throw new Error(`INVALID_CRON_EXPRESSION: ${expression}`);
  }
  const dayOfWeek = expandField(field4, 0, 7);
  const normalizedDayOfWeek = new Set<number>();
  for (const value of dayOfWeek) normalizedDayOfWeek.add(value === 7 ? 0 : value);
  return {
    minute: expandField(field0, 0, 59),
    hour: expandField(field1, 0, 23),
    dayOfMonth: expandField(field2, 1, 31),
    month: expandField(field3, 1, 12),
    dayOfWeek: normalizedDayOfWeek
  };
}

function cronNextRun(fields: CronFields, timeZone: string, from: Date): ScheduleComputationResult {
  const candidate = new Date(from.getTime() + MINUTE_MS);
  for (let step = 0; step < MAX_LOOKAHEAD_MINUTES; step += 1) {
    const parts = wallClockParts(candidate, timeZone);
    const domMatches = fields.dayOfMonth.size === 31 || fields.dayOfMonth.has(parts.day);
    const dowMatches = fields.dayOfWeek.has(parts.weekday);
    if (
      fields.month.has(parts.month) &&
      fields.hour.has(parts.hour) &&
      fields.minute.has(parts.minute) &&
      (domMatches || dowMatches)
    ) {
      return { nextRun: candidate };
    }
    candidate.setTime(candidate.getTime() + MINUTE_MS);
  }
  return { nextRun: null };
}

function parseAtTime(atTime: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(atTime.trim());
  if (!match) throw new Error(`INVALID_AT_TIME: ${atTime}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error(`INVALID_AT_TIME: ${atTime}`);
  return { hour, minute };
}

function dailyNextRun(atTime: string, timeZone: string, from: Date): ScheduleComputationResult {
  return timeOfDayNextRun(atTime, timeZone, from, () => true);
}

function weeklyNextRun(
  daysOfWeek: number[],
  atTime: string,
  timeZone: string,
  from: Date
): ScheduleComputationResult {
  const days = new Set(daysOfWeek);
  return timeOfDayNextRun(atTime, timeZone, from, (parts) => days.has(parts.weekday));
}

function monthlyNextRun(
  dayOfMonth: number,
  atTime: string,
  timeZone: string,
  from: Date
): ScheduleComputationResult {
  return timeOfDayNextRun(atTime, timeZone, from, (parts) => parts.day === dayOfMonth);
}

function timeOfDayNextRun(
  atTime: string,
  timeZone: string,
  from: Date,
  dayPredicate: (parts: TimeZoneParts) => boolean
): ScheduleComputationResult {
  const { hour, minute } = parseAtTime(atTime);
  const candidate = new Date(from.getTime() + MINUTE_MS);
  for (let step = 0; step < MAX_LOOKAHEAD_MINUTES; step += 1) {
    const parts = wallClockParts(candidate, timeZone);
    if (dayPredicate(parts) && parts.hour === hour && parts.minute === minute) {
      return { nextRun: candidate };
    }
    candidate.setTime(candidate.getTime() + MINUTE_MS);
  }
  return { nextRun: null };
}

/** Computes the next run for any schedule trigger type. One-shot triggers return `from` itself only
 *  for DATE/ONE_TIME (persisted as the requested fire time); recurring triggers return a future run. */
export function computeScheduleNextRun(
  input: {
    triggerType: "CRON" | "INTERVAL" | "DAILY" | "WEEKLY" | "MONTHLY";
    cronExpression?: string | null;
    intervalMs?: number | null;
    atTime?: string | null;
    daysOfWeek?: number[];
    dayOfMonth?: number | null;
    timeZone?: string;
  },
  from: Date
): Date | null {
  const spec: RecurringScheduleSpec = {
    triggerType: input.triggerType,
    cronExpression: input.cronExpression ?? null,
    interval: input.intervalMs ?? null,
    ...(input.atTime !== undefined ? { atTime: input.atTime } : {}),
    ...(input.daysOfWeek !== undefined ? { daysOfWeek: input.daysOfWeek } : {}),
    ...(input.dayOfMonth !== undefined ? { dayOfMonth: input.dayOfMonth } : {}),
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {})
  };
  return computeNextRun(spec, from).nextRun;
}

/** Default reminder fire-times for the DAILY-style autonomous templates, e.g. "09:30". */
export function isValidAtTime(value: string): boolean {
  try {
    parseAtTime(value);
    return true;
  } catch {
    return false;
  }
}
