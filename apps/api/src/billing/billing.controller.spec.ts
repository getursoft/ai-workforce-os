import { describe, expect, it, vi } from "vitest";
import { BillingController } from "./billing.controller";
import type { BillingService } from "./billing.service";

/** Real UAT bug: today's own AI-employee activity silently vanished from every usage view whose date range
 *  ended "today" (the default range on both the Dashboard and Usage pages) — a bare "YYYY-MM-DD" `end` query
 *  param parses to that day's UTC midnight, excluding everything recorded later that same day. Confirmed
 *  against production data: 6 of 7 active AI employees (Legal/Finance/Marketing/Sales/IT/HR, all with real,
 *  same-day executions) disappeared from the usage-by-employee breakdown because of this. */
describe("BillingController.resolvePeriod (via byEmployee)", () => {
  it("treats a bare end date as end-of-day (23:59:59.999), never that day's UTC midnight", async () => {
    const byEmployee = vi.fn().mockResolvedValue([]);
    const billing = { byEmployee } as unknown as BillingService;
    const controller = new BillingController(billing);

    await controller.byEmployee(
      { organizationId: { toString: () => "org-1" } } as never,
      "2026-07-01",
      "2026-07-31"
    );

    expect(byEmployee).toHaveBeenCalledTimes(1);
    const [, start, end] = byEmployee.mock.calls[0] as [string, Date, Date];
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("leaves an already-precise ISO timestamp untouched", async () => {
    const byEmployee = vi.fn().mockResolvedValue([]);
    const billing = { byEmployee } as unknown as BillingService;
    const controller = new BillingController(billing);

    await controller.byEmployee(
      { organizationId: { toString: () => "org-1" } } as never,
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T12:34:56.000Z"
    );

    const [, , end] = byEmployee.mock.calls[0] as [string, Date, Date];
    expect(end.toISOString()).toBe("2026-07-31T12:34:56.000Z");
  });
});
