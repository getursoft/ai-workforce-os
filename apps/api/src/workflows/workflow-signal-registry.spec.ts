import { describe, expect, it } from "vitest";
import type { WorkflowDispatchOutcome } from "./workflow-runtime.contracts";
import {
  buildWorkflowSignalRegistry,
  WorkflowSignalRegistry,
  type WorkflowSignalProvider
} from "./workflow-signal-registry";

const HANDLED: WorkflowDispatchOutcome = {
  handled: true,
  workflowType: "CONTACT_CAPTURE",
  decision: "ASK_FOR_INPUT",
  responseText: "hi",
  leadCreated: null
};

describe("WorkflowSignalRegistry", () => {
  it("resolves a registered handler for its signal type", () => {
    const registry = new WorkflowSignalRegistry();
    registry.register("START_CONTACT_CAPTURE", async () => HANDLED);
    expect(registry.resolve("START_CONTACT_CAPTURE")).not.toBeNull();
  });

  it("returns null for an unregistered signal type — never throws", () => {
    const registry = new WorkflowSignalRegistry();
    expect(registry.resolve("START_BOOKING_HANDOFF")).toBeNull();
    expect(registry.resolve("NONE")).toBeNull();
  });

  it("Stage 9E.1: a duplicate registration for the same signal type fails deterministically (fail fast, never a silent overwrite)", () => {
    const registry = new WorkflowSignalRegistry();
    registry.register("START_CONTACT_CAPTURE", async () => HANDLED);
    expect(() => registry.register("START_CONTACT_CAPTURE", async () => HANDLED)).toThrow(
      /WORKFLOW_SIGNAL_HANDLER_ALREADY_REGISTERED/
    );
  });
});

describe("buildWorkflowSignalRegistry — employee-agnostic registration proof (Stage 9E.1)", () => {
  /** A fixture standing in for a future, non-Travel employee module's own provider — it knows nothing
   *  about ContactCaptureWorkflowService/TripSubmissionWorkflowService/BookingHandoffWorkflowService, and
   *  the registry/coordinator never need to know it exists by name. Proves the registration mechanism
   *  itself is generic: any object satisfying `WorkflowSignalProvider` composes into the same registry. */
  function fixtureSignalProvider(): WorkflowSignalProvider {
    return {
      signalType: "START_BOOKING_HANDOFF",
      handler: async () => ({
        handled: true,
        workflowType: "BOOKING_HANDOFF",
        decision: "ASK_FOR_INPUT",
        responseText: "fixture handler response",
        leadCreated: null
      })
    };
  }

  it("builds a working registry purely from an array of providers, with no reference to any concrete workflow service", async () => {
    const registry = buildWorkflowSignalRegistry([fixtureSignalProvider()]);
    const handler = registry.resolve("START_BOOKING_HANDOFF");
    expect(handler).not.toBeNull();
    const outcome = await handler?.(
      { organizationId: "o", pluginInstallationId: "p", conversationId: "c" },
      {
        signalType: "START_BOOKING_HANDOFF",
        workflowType: "BOOKING_HANDOFF",
        source: "BOOKING_READY_CAPABILITY",
        sourceTurnId: "t",
        sourceSkillExecutionId: null,
        payload: {},
        confidence: 1
      },
      "t",
      null,
      ""
    );
    expect(outcome?.responseText).toBe("fixture handler response");
  });

  it("two providers claiming the same signal type fail deterministically when composed into one registry", () => {
    expect(() => buildWorkflowSignalRegistry([fixtureSignalProvider(), fixtureSignalProvider()])).toThrow(
      /WORKFLOW_SIGNAL_HANDLER_ALREADY_REGISTERED/
    );
  });

  it("an empty provider list produces a registry that resolves nothing — deterministically null, never a silent LLM fallback disguised as success", () => {
    const registry = buildWorkflowSignalRegistry([]);
    expect(registry.resolve("START_CONTACT_CAPTURE")).toBeNull();
    expect(registry.resolve("START_TRIP_SUBMISSION")).toBeNull();
    expect(registry.resolve("START_BOOKING_HANDOFF")).toBeNull();
  });
});
