import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import type { TraceContext } from "./trace-context";

/**
 * Sprint 4.7A: lets deeply-nested code (WorkflowExecutionService, the channel pipeline, etc.) read the
 * TraceContext of the span currently in progress WITHOUT threading a `traceContext` parameter through
 * every intermediate method signature. ObservabilityService.withSpan() runs its callback inside
 * `run(span, ...)`, so any code awaited underneath it — however many layers down, including through
 * WorkflowCoordinator's business-logic files, which this pass must not modify — can call `get()` to find
 * the current span. This is purely additive: nothing that already receives an explicit TraceContext
 * parameter needs to change, and code that never calls `get()` behaves exactly as before.
 */
@Injectable()
export class TraceContextStore {
  private readonly als = new AsyncLocalStorage<TraceContext>();

  run<T>(context: TraceContext | null | undefined, fn: () => T): T {
    if (!context) return fn();
    return this.als.run(context, fn);
  }

  get(): TraceContext | undefined {
    return this.als.getStore();
  }
}
