import { Prisma, WorkflowStatus, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { TravelLeadService } from "../../travel/travel-lead.service";
import { LeadService } from "../../leads/lead.service";
import { WorkflowExecutionService } from "../workflow-execution.service";
import type { WorkflowExecutionScope } from "../workflow-runtime.contracts";
import { ContactCaptureWorkflowService } from "./contact-capture.service";
import type { ContactCaptureStartSignals, ContactCaptureTripContext } from "./contact-capture.types";

const NO_SIGNALS: ContactCaptureStartSignals = {
  providerFailure: null,
  completionStage: null
};

const scope: WorkflowExecutionScope = {
  organizationId: "org-1",
  pluginInstallationId: "plugin-1",
  conversationId: "conversation-1",
  workflowType: "CONTACT_CAPTURE"
};

const TRIP_CONTEXT: ContactCaptureTripContext = {
  originCity: "Delhi",
  destinationCity: "Dubai",
  travelDates: "17 August 2026",
  passengers: "5",
  tripPurpose: null,
  budgetAmount: 500000,
  budgetCurrency: "INR",
  displayCurrency: "INR",
  journeyId: null,
  customerName: null
};

function fakeWorkflowPrisma() {
  const rows: WorkflowExecution[] = [];
  return {
    rows,
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matchesWorkflow(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3"
          });
        const now = new Date();
        const row = {
          id: `workflow-${rows.length + 1}`,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data
        } as WorkflowExecution;
        rows.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((candidate) => matchesWorkflow(candidate, where));
        if (!row) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "revision" && typeof value === "object" && value)
            row.revision += (value as { increment: number }).increment;
          else (row as unknown as Record<string, unknown>)[key] = value;
        }
        row.updatedAt = new Date();
        return { count: 1 };
      }
    }
  };
}

function fakeLeadPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    rows,
    travelLead: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) =>
        rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.idempotencyKey && rows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: { target: ["idempotency_key"] }
          });
        }
        counter += 1;
        const row = { id: `lead-${counter}`, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        Object.assign(row as object, data);
        return row;
      }
    }
  };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value in test setup");
  return value;
}

function harness() {
  const workflowPrisma = fakeWorkflowPrisma();
  const leadPrisma = fakeLeadPrisma();
  const workflows = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
  const travelLeadService = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
  const service = new ContactCaptureWorkflowService(workflows, travelLeadService);
  return { service, workflows, travelLeadService, workflowPrisma, leadPrisma };
}

function matchesWorkflow(row: WorkflowExecution, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (typeof expected === "object" && expected !== null) {
      const condition = expected as { in?: unknown[]; not?: unknown };
      if (condition.in && !condition.in.includes(actual)) return false;
      if ("not" in condition && actual === condition.not) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

describe("ContactCaptureWorkflowService.shouldStart", () => {
  const { service } = harness();

  it("starts on an explicit menu option 3 selection while the recovery menu is active", () => {
    expect(
      service.shouldStart("3", {
        ...NO_SIGNALS,
        providerFailure: {
          failedAction: "SEARCH_LIVE_OPTIONS",
          provider: "test",
          failedAt: new Date().toISOString(),
          retryable: true,
          selectedRecoveryAction: null,
          menuActive: true,
          menuExpiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      })
    ).toBe(true);
  });

  it("does not start on a bare '3' when no recovery menu is active", () => {
    expect(service.shouldStart("3", NO_SIGNALS)).toBe(false);
  });

  it.each(["contact me", "speak to an advisor", "talk to an advisor", "callback", "create a lead", "call me"])(
    "starts on the explicit phrase %j",
    (text) => {
      expect(service.shouldStart(text, NO_SIGNALS)).toBe(true);
    }
  );

  it("does not start on an unrelated message", () => {
    expect(service.shouldStart("plan a trip to Dubai", NO_SIGNALS)).toBe(false);
  });

  it("starts on an affirmative reply while completionStage is OFFERED (was the proactive completion-offer flow)", () => {
    expect(service.shouldStart("yes please", { ...NO_SIGNALS, completionStage: "OFFERED" })).toBe(true);
  });

  it("does not start on an affirmative reply when completionStage is not OFFERED", () => {
    expect(service.shouldStart("yes please", NO_SIGNALS)).toBe(false);
  });

  it("does not start on a booking confirmation after an itinerary was presented — this is the distinct trip-submission flow, not a callback ask, and is deliberately left with Travel Runtime", () => {
    expect(service.shouldStart("yes, book it", NO_SIGNALS)).toBe(false);
  });

  it("does not start on a bare volunteered phone number — CONFIRM_STANDALONE_CONTACT_USE is deliberately left with Travel Runtime", () => {
    expect(service.shouldStart("you can reach me at 8380031193", NO_SIGNALS)).toBe(false);
    expect(service.shouldStart("8380031193", NO_SIGNALS)).toBe(false);
  });
});

describe("ContactCaptureWorkflowService: starting the workflow", () => {
  it("asks for the mobile number and persists a WAITING_FOR_INPUT workflow", async () => {
    const { service, workflows } = harness();
    const result = await service.start(scope, "turn-1");
    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.pendingInput).toBe("MOBILE_NUMBER");
    expect(result.responseText).toContain("mobile number");
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: WorkflowStatus.WAITING_FOR_INPUT,
      pendingInput: "MOBILE_NUMBER"
    });
  });
});

describe("ContactCaptureWorkflowService: resuming with a phone number", () => {
  it("rejects an invalid phone number, remains WAITING_FOR_INPUT, creates no lead", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1");
    const execution = await workflows.findActiveWorkflow(scope);

    const result = await service.resume(must(execution), "12345", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.status).toBe("WAITING_FOR_INPUT");
    expect(result.leadCreated).toBeNull();
    expect(leadPrisma.rows).toHaveLength(0);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: WorkflowStatus.WAITING_FOR_INPUT
    });
  });

  it("accepts the UAT phone number 8380031193, creates the lead, and completes with a truthful confirmation", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1");
    const execution = await workflows.findActiveWorkflow(scope);

    const result = await service.resume(must(execution), "8380031193", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.status).toBe("COMPLETED");
    expect(result.responseText).toBe(
      "Your callback request has been saved. A travel advisor can contact you on 8380031193 regarding your Delhi to Dubai trip."
    );
    expect(result.leadCreated).not.toBeNull();
    expect(result.leadCreated?.phoneNumber).toBe("8380031193");
    expect(leadPrisma.rows).toHaveLength(1);
    expect(result.state.mobileNumber).toBe("8380031193");
    expect(result.state.leadId).toBe(result.leadCreated?.id);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("does not classify the phone-number turn as travel search — the workflow owns it entirely and no search/RAG hook is ever invoked", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1");
    const execution = await workflows.findActiveWorkflow(scope);

    const result = await service.resume(must(execution), "8380031193", "turn-2", TRIP_CONTEXT);

    expect(result.responseText).not.toMatch(/retrieve the options|retry the search/i);
  });

  it("retry/idempotency: processing the exact same phone turn twice creates exactly one lead and never re-transitions", async () => {
    const { service, workflows, leadPrisma } = harness();
    await service.start(scope, "turn-1");
    const execution = await workflows.findActiveWorkflow(scope);
    // A real PrismaService returns a fresh plain object per query — snapshot (deep-clone) it so a
    // simulated concurrent duplicate call holds the SAME stale pre-mutation state a second in-flight
    // request would have, rather than observing this in-memory mock's shared row mutation.
    const staleSnapshot = structuredClone(must(execution));

    const first = await service.resume(must(execution), "8380031193", "duplicate-turn", TRIP_CONTEXT);
    // Simulate a duplicate delivery of the exact same turn arriving again before any other turn — the
    // caller would still pass the same (now stale) execution snapshot in a genuinely concurrent replay.
    const second = await service.resume(staleSnapshot, "8380031193", "duplicate-turn", TRIP_CONTEXT);

    expect(first.leadCreated).not.toBeNull();
    expect(second.leadCreated).toBeNull(); // no duplicate CRM/lead trigger on replay
    expect(leadPrisma.rows).toHaveLength(1);
    expect(second.responseText).toBe(first.responseText);
  });

  it("restart durability: a freshly constructed service resumes a workflow persisted by a previous instance", async () => {
    const { workflowPrisma, leadPrisma } = harness();
    const workflowsA = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
    const travelLeadA = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
    const serviceA = new ContactCaptureWorkflowService(workflowsA, travelLeadA);
    await serviceA.start(scope, "turn-1");

    // Recreate everything from scratch against the same underlying rows, as if the process restarted.
    const workflowsB = new WorkflowExecutionService(workflowPrisma as unknown as PrismaService);
    const travelLeadB = new TravelLeadService(leadPrisma as unknown as PrismaService, new LeadService(leadPrisma as unknown as PrismaService));
    const serviceB = new ContactCaptureWorkflowService(workflowsB, travelLeadB);

    const active = await workflowsB.findActiveWorkflow(scope);
    expect(active).not.toBeNull();
    const result = await serviceB.resume(must(active), "8380031193", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toContain("8380031193");
  });
});
