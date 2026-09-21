/** Sprint 7.12 STEP 34 — in-memory interaction/notification metrics, mirroring VoiceMetricsService's
 * shape exactly (no prom-client dependency in this codebase — see that file's own doc comment). */
import { Injectable } from "@nestjs/common";

export type InteractionCounterName =
  | "interactions_started_total"
  | "interactions_completed_total"
  | "interactions_failed_total"
  | "reference_notifications_requested_total"
  | "reference_notifications_sent_total"
  | "reference_notifications_failed_total"
  | "reference_lookup_total"
  | "reference_lookup_not_found_total";

@Injectable()
export class InteractionMetricsService {
  private readonly counters = new Map<InteractionCounterName, number>();

  increment(name: InteractionCounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot() {
    return { counters: Object.fromEntries(this.counters) };
  }
}
