import { Prisma, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { WorkflowExecutionService } from "../workflow-execution.service";
import type { WorkflowExecutionScope } from "../workflow-runtime.contracts";
import { BookingHandoffWorkflowService } from "./booking-handoff.service";
import type { BookingHandoffTripContext } from "./booking-handoff.types";

const scope: WorkflowExecutionScope = {
  organizationId: "org-1",
  pluginInstallationId: "plugin-1",
  conversationId: "conversation-1",
  workflowType: "BOOKING_HANDOFF"
};

const TRIP_CONTEXT: BookingHandoffTripContext = {
  originCity: "Delhi",
  destinationCity: "Dubai",
  travelDates: "17 August 2026",
  skillExecutionId: "skill-execution-1",
  journeyId: null
};

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value in test setup");
  return value;
}

function fakePrisma() {
  const rows: WorkflowExecution[] = [];
  return {
    rows,
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3"
          });
        const now = new Date();
        const row = { id: `workflow-${rows.length + 1}`, completedAt: null, createdAt: now, updatedAt: now, ...data } as WorkflowExecution;
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => matches(candidate, where));
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

function matches(row: WorkflowExecution, where: Record<string, unknown>): boolean {
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

function harness() {
  const prisma = fakePrisma();
  const workflows = new WorkflowExecutionService(prisma as unknown as PrismaService);
  const service = new BookingHandoffWorkflowService(workflows);
  return { service, workflows, prisma };
}

describe("BookingHandoffWorkflowService: starting the workflow", () => {
  it("asks a single confirmation question and persists a WAITING_FOR_INPUT workflow, never claiming a reservation", async () => {
    const { service, workflows } = harness();
    const result = await service.start(scope, "turn-1", TRIP_CONTEXT);
    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.pendingInput).toBe("BOOKING_CONFIRMATION");
    expect(result.responseText).toMatch(/booking request/i);
    expect(result.responseText).not.toMatch(/confirmed|reserved|reservation made|payment (initiated|made)/i);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({
      status: "WAITING_FOR_INPUT",
      pendingInput: "BOOKING_CONFIRMATION"
    });
  });

  it("is idempotent: starting twice with the same scope resumes the existing workflow instead of creating a second row", async () => {
    const { service, prisma } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT);
    await service.start(scope, "turn-2", TRIP_CONTEXT);
    expect(prisma.rows).toHaveLength(1);
  });
});

describe("BookingHandoffWorkflowService: resuming with a confirmation", () => {
  it("re-asks when the reply is not an explicit confirmation, without persisting a state change", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT);
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "what does that mean?", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("ASK_FOR_INPUT");
    expect(result.status).toBe("WAITING_FOR_INPUT");
    await expect(workflows.findActiveWorkflow(scope)).resolves.toMatchObject({ status: "WAITING_FOR_INPUT" });
  });

  it("persists the booking intent and completes on an explicit 'yes', with an honest no-reservation response", async () => {
    const { service, workflows } = harness();
    await service.start(scope, "turn-1", TRIP_CONTEXT);
    const execution = must(await workflows.findActiveWorkflow(scope));

    const result = await service.resume(execution, "yes, please proceed", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toBe(
      "Your booking request for the Delhi to Dubai trip has been approved and saved."
    );
    expect(result.responseText).not.toMatch(/booking confirmed|seat reserved|hotel reserved|payment initiated|advisor assigned/i);
    expect(result.state.confirmed).toBe(true);
    expect(result.state.readyForFutureWorkflow).toBe(true);
    await expect(workflows.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("restart durability: a freshly constructed service resumes a workflow persisted by a previous instance", async () => {
    const { prisma } = harness();
    const workflowsA = new WorkflowExecutionService(prisma as unknown as PrismaService);
    const serviceA = new BookingHandoffWorkflowService(workflowsA);
    await serviceA.start(scope, "turn-1", TRIP_CONTEXT);

    const workflowsB = new WorkflowExecutionService(prisma as unknown as PrismaService);
    const serviceB = new BookingHandoffWorkflowService(workflowsB);
    const active = must(await workflowsB.findActiveWorkflow(scope));
    const result = await serviceB.resume(active, "yes", "turn-2", TRIP_CONTEXT);

    expect(result.decision).toBe("COMPLETE");
    expect(result.responseText).toContain("Delhi to Dubai");
  });
});
