import { describe, expect, it, vi } from "vitest";
import { InteractionCompletionService } from "./interaction-completion.service";
import { InteractionMetricsService } from "./interaction-metrics.service";

function buildService(overrides: { alreadyTerminal?: boolean } = {}) {
  const complete = vi.fn().mockResolvedValue({
    interaction: { id: "interaction-1" },
    alreadyTerminal: overrides.alreadyTerminal ?? false
  });
  const fail = vi.fn().mockResolvedValue({ interaction: { id: "interaction-1" }, alreadyTerminal: false });
  const interactions = { complete, fail } as never;
  const publish = vi.fn().mockResolvedValue({ id: "queue-1" });
  const queue = { publish } as unknown as never;
  const metrics = new InteractionMetricsService();
  const service = new InteractionCompletionService(interactions, metrics, queue);
  return { service, complete, fail, publish, queue, metrics };
}

describe("InteractionCompletionService.detectsClosing (Sprint 7.12 STEP 9)", () => {
  it.each([
    "That's all, thanks!",
    "no that's it",
    "Nothing else, bye",
    "goodbye",
    "We're all done here",
    "thanks, bye"
  ])("recognizes %j as a closing remark", (text) => {
    const { service } = buildService();
    expect(service.detectsClosing(text)).toBe(true);
  });

  it.each(["Can you also check hotels?", "What about my return flight?", "yes please"])(
    "does not treat an ordinary follow-up %j as a closing remark",
    (text) => {
      const { service } = buildService();
      expect(service.detectsClosing(text)).toBe(false);
    }
  );
});

describe("InteractionCompletionService.complete", () => {
  it("marks complete, increments the metric, and enqueues notification job", async () => {
    const { service, publish, metrics } = buildService();
    await service.complete("org-1", "interaction-1", "Booked a Dubai trip");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1",
      category: "NOTIFICATION_JOBS",
      refType: "Interaction",
      refId: "interaction-1"
    }));
    expect(metrics.snapshot().counters.interactions_completed_total).toBe(1);
  });

  it("is idempotent: a duplicate completion signal never re-triggers notification (STEP 31)", async () => {
    const { service, publish, metrics } = buildService({ alreadyTerminal: true });
    await service.complete("org-1", "interaction-1");
    expect(publish).not.toHaveBeenCalled();
    expect(metrics.snapshot().counters.interactions_completed_total ?? 0).toBe(0);
  });

  it("never throws even if the queue publish itself rejects", async () => {
    const { service, publish } = buildService();
    publish.mockRejectedValueOnce(new Error("boom"));
    await expect(service.complete("org-1", "interaction-1")).resolves.toBeUndefined();
  });
});

describe("InteractionCompletionService.fail", () => {
  it("marks failed and increments the metric", async () => {
    const { service, fail, metrics } = buildService();
    await service.fail("org-1", "interaction-1", "Provider unavailable");
    expect(fail).toHaveBeenCalledWith("org-1", "interaction-1", { resolutionSummary: "Provider unavailable" });
    expect(metrics.snapshot().counters.interactions_failed_total).toBe(1);
  });
});
