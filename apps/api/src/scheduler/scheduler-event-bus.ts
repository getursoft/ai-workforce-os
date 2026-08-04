/**
 * Sprint 4.8 — Scheduler Event Bus (Phase 4).
 *
 * A small typed in-process event bus for the domain events the scheduler reacts to. It is deliberately a
 * NEW module (not a modification of WorkforceEventBus): the scheduler subscribes to the existing
 * `WorkforceEventBus.approval.decided` emissions (already produced by the Approval Engine) and bridges
 * them in, while every other domain event is produced either by the SchedulerEventBridge reconciliation
 * scan (crash-safe fallback that never modifies an existing engine) or by the scheduler's own
 * PUBLISH_EVENT handler.
 */

import { Global, Injectable, Module } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { SchedulerDomainEvent, SchedulerDomainEventName } from "./scheduler.types";

@Injectable()
export class SchedulerEventBus {
  private readonly emitter = new EventEmitter();
  private readonly anyListeners: Array<(event: SchedulerDomainEvent) => void> = [];

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: SchedulerDomainEvent): void {
    this.emitter.emit(event.name, event);
    for (const listener of this.anyListeners) listener(event);
  }

  on(name: SchedulerDomainEventName, handler: (event: SchedulerDomainEvent) => void): void {
    this.emitter.on(name, handler);
  }

  /** Generic listener — receives every domain event the scheduler emits (used by tests/observers). */
  onAny(handler: (event: SchedulerDomainEvent) => void): void {
    this.anyListeners.push(handler);
  }
}

@Global()
@Module({
  providers: [SchedulerEventBus],
  exports: [SchedulerEventBus]
})
export class SchedulerEventsModule {}
