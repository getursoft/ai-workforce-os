import type { BookingHandoffWorkflowService } from "./booking-handoff/booking-handoff.service";
import type { BookingHandoffTripContext } from "./booking-handoff/booking-handoff.types";
import type { ContactCaptureWorkflowService } from "./contact-capture/contact-capture.service";
import type { TripSubmissionWorkflowService } from "./trip-submission/trip-submission.service";
import type { TripSubmissionStartTrigger } from "./trip-submission/trip-submission.types";
import type {
  WorkflowDispatchOutcome,
  WorkflowDispatchSignals,
  WorkflowExecutionScope
} from "./workflow-runtime.contracts";
import type { WorkflowSignal, WorkflowSignalType } from "./workflow-signal.contracts";

/**
 * Stage 9E: a handler executes one already-fired `WorkflowSignal` — it is never asked "should I start?"
 * (that question belongs to `WorkflowSignalEngine`/the signal's emitter, never the registry or
 * `WorkflowCoordinator`). `dispatchSignals`/`text` are the same per-turn context `WorkflowCoordinator`
 * already receives; a handler reads only the slice it needs.
 */
export type WorkflowSignalHandler = (
  scope: Omit<WorkflowExecutionScope, "workflowType">,
  signal: WorkflowSignal,
  turnId: string,
  dispatchSignals: WorkflowDispatchSignals | null,
  text: string
) => Promise<WorkflowDispatchOutcome>;

/**
 * Stage 9E.1: what an employee/plugin module contributes — one signal type and the handler that executes
 * it. This is the unit a NestJS module registers via dependency injection (see `WORKFLOW_SIGNAL_PROVIDERS`
 * below); `WorkflowSignalRegistry`/`WorkflowCoordinator` only ever consume an array of these, never a named
 * concrete workflow service.
 */
export interface WorkflowSignalProvider {
  readonly signalType: Exclude<WorkflowSignalType, "NONE">;
  readonly handler: WorkflowSignalHandler;
}

/**
 * The DI token every employee/plugin module registers its `WorkflowSignalProvider`s against. NestJS has no
 * built-in Angular-style `multi: true` provider — the established idiom (used here) is a single provider
 * whose `useFactory` returns the aggregated array, built from each concrete service the composition root
 * (`agent.module.ts`) already knows how to construct. A future second AI Employee's module would supply its
 * OWN array (its own providers, injected with its own services) under the same token; NestJS module
 * providers for the same token in the same module override, so a real multi-employee setup would compose
 * this at a higher module boundary — out of scope for the one-employee proof this stage requires (see
 * "Handler registration should fail safely" below for what stays true either way: the REGISTRY itself never
 * needs to know how many sources contributed to the array it was built from).
 */
export const WORKFLOW_SIGNAL_PROVIDERS = Symbol("WORKFLOW_SIGNAL_PROVIDERS");

/**
 * Generic `WorkflowSignalType -> WorkflowSignalHandler` map. Contains no workflow-specific logic itself.
 * `register` fails fast (throws) on a duplicate signal type — a configuration bug (two providers claiming
 * the same signal) must be loud at startup, never a silent overwrite.
 */
export class WorkflowSignalRegistry {
  private readonly handlers = new Map<WorkflowSignalType, WorkflowSignalHandler>();

  register(signalType: Exclude<WorkflowSignalType, "NONE">, handler: WorkflowSignalHandler): void {
    if (this.handlers.has(signalType))
      throw new Error(`WORKFLOW_SIGNAL_HANDLER_ALREADY_REGISTERED: ${signalType}`);
    this.handlers.set(signalType, handler);
  }

  resolve(signalType: WorkflowSignalType): WorkflowSignalHandler | null {
    return this.handlers.get(signalType) ?? null;
  }
}

/** Builds a registry from an arbitrary list of providers — used both for the real, DI-supplied provider
 *  array and for a test double proving the mechanism (see `workflow-signal-registry.spec.ts`). Duplicate
 *  signal types across providers fail deterministically via `WorkflowSignalRegistry.register` above. */
export function buildWorkflowSignalRegistry(
  providers: readonly WorkflowSignalProvider[]
): WorkflowSignalRegistry {
  const registry = new WorkflowSignalRegistry();
  for (const provider of providers) registry.register(provider.signalType, provider.handler);
  return registry;
}

function contactCaptureSignalProvider(contactCapture: ContactCaptureWorkflowService): WorkflowSignalProvider {
  return {
    signalType: "START_CONTACT_CAPTURE",
    handler: async (scope, _signal, turnId) => {
      const contactScope = { ...scope, workflowType: "CONTACT_CAPTURE" as const };
      const result = await contactCapture.start(contactScope, turnId);
      return {
        handled: true,
        workflowType: "CONTACT_CAPTURE",
        decision: result.decision,
        responseText: result.responseText,
        leadCreated: null
      };
    }
  };
}

function tripSubmissionSignalProvider(tripSubmission: TripSubmissionWorkflowService): WorkflowSignalProvider {
  return {
    signalType: "START_TRIP_SUBMISSION",
    handler: async (scope, signal, turnId, dispatchSignals, text) => {
      // dispatchSignals is only ever null when a caller dispatches a START_TRIP_SUBMISSION signal without
      // trip context, which never happens on any current path (both the free-text engine and Travel
      // Runtime's BELOW_MINIMUM signal always carry it) — defensive, not reachable in practice.
      if (!dispatchSignals)
        return {
          handled: false,
          workflowType: "TRIP_SUBMISSION",
          decision: "FAIL",
          responseText: null,
          leadCreated: null
        };
      const tripSubmissionScope = { ...scope, workflowType: "TRIP_SUBMISSION" as const };
      const trigger = signal.payload.trigger as Exclude<TripSubmissionStartTrigger, "NONE">;
      const result = await tripSubmission.start(
        tripSubmissionScope,
        turnId,
        dispatchSignals.tripSubmissionTripContext,
        trigger,
        text
      );
      return {
        handled: true,
        workflowType: "TRIP_SUBMISSION",
        decision: result.decision,
        responseText: result.responseText,
        leadCreated: result.leadCreated
      };
    }
  };
}

function bookingHandoffSignalProvider(bookingHandoff: BookingHandoffWorkflowService): WorkflowSignalProvider {
  return {
    signalType: "START_BOOKING_HANDOFF",
    handler: async (scope, signal, turnId) => {
      const bookingScope = { ...scope, workflowType: "BOOKING_HANDOFF" as const };
      const tripContext = signal.payload.tripContext as BookingHandoffTripContext;
      const result = await bookingHandoff.start(bookingScope, turnId, tripContext);
      return {
        handled: true,
        workflowType: "BOOKING_HANDOFF",
        decision: result.decision,
        responseText: result.responseText,
        leadCreated: null,
        // Fix (Travel Booking UAT correction pass): a customer-confirmation booking that starts AND
        // completes synchronously within this same signal dispatch (see `start()`'s own doc comment above)
        // never went through `WorkflowCoordinator.resume()` — which is the only place this was previously
        // populated — so the PDF ticket attachment AgentService builds from `bookingId` was silently never
        // attached to chat for this path. Mirrors `resume()`'s own `ticketReady && bookingId` guard exactly.
        ...(result.state.ticketReady && result.state.bookingId ? { bookingId: result.state.bookingId } : {})
      };
    }
  };
}

/** Today's three `WorkflowSignalProvider`s — this is the ONE place in the Workflow Runtime that knows the
 *  concrete Contact Capture/Trip Submission/Booking Handoff services, deliberately kept out of
 *  `workflow-coordinator.ts`. `agent.module.ts` supplies this array to the `WORKFLOW_SIGNAL_PROVIDERS`
 *  token via a NestJS `useFactory` provider; `WorkflowCoordinator` falls back to building it internally
 *  (from the same three constructor-injected services it already receives for resume/cancel dispatch —
 *  see its own doc comment) only when nothing was supplied via that token, so every pre-Stage-9E.1 test
 *  that constructs it directly is unaffected. */
export function buildDefaultWorkflowSignalProviders(
  contactCapture: ContactCaptureWorkflowService,
  bookingHandoff: BookingHandoffWorkflowService,
  tripSubmission: TripSubmissionWorkflowService
): WorkflowSignalProvider[] {
  return [
    contactCaptureSignalProvider(contactCapture),
    tripSubmissionSignalProvider(tripSubmission),
    bookingHandoffSignalProvider(bookingHandoff)
  ];
}

/** @deprecated kept only as a thin convenience wrapper — prefer `buildWorkflowSignalRegistry(
 *  buildDefaultWorkflowSignalProviders(...))` so provider construction and registry assembly stay visibly
 *  separate steps. */
export function buildDefaultWorkflowSignalRegistry(
  contactCapture: ContactCaptureWorkflowService,
  bookingHandoff: BookingHandoffWorkflowService,
  tripSubmission: TripSubmissionWorkflowService
): WorkflowSignalRegistry {
  return buildWorkflowSignalRegistry(
    buildDefaultWorkflowSignalProviders(contactCapture, bookingHandoff, tripSubmission)
  );
}
