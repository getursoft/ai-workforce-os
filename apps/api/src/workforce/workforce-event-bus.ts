import { Global, Injectable, Module } from "@nestjs/common";
import { EventEmitter } from "node:events";

export interface ApprovalDecidedEvent {
  approvalRequestId: string;
  organizationId: string;
  workflowExecutionId: string;
  decision: "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "EXPIRED" | "CANCELLED" | "SUPERSEDED";
}

/**
 * Sprint 4.6 (continued) — the smallest possible in-process push mechanism: a plain Node EventEmitter
 * wrapped for typed emit/subscribe. No message broker exists in this codebase and none is warranted for a
 * single-process NestJS app; this is a real, synchronous, in-process event, not a poll. Declared in its own
 * tiny `@Global()` module so both ApprovalModule (the emitter) and WorkforceModule (the subscriber) can
 * inject it without a direct module-to-module dependency.
 */
@Injectable()
export class WorkforceEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Multiple delegated approval-gated tasks / orchestrator instances could each subscribe in a busier
    // future; raise the default ceiling rather than let Node's leak-detector warn on a legitimate pattern.
    this.emitter.setMaxListeners(50);
  }

  emitApprovalDecided(event: ApprovalDecidedEvent): void {
    this.emitter.emit("approval.decided", event);
  }

  onApprovalDecided(handler: (event: ApprovalDecidedEvent) => void): void {
    this.emitter.on("approval.decided", handler);
  }
}

@Global()
@Module({
  providers: [WorkforceEventBus],
  exports: [WorkforceEventBus]
})
export class WorkforceEventsModule {}
