import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { TravelLeadService, type CreateInternalLeadInput } from "./travel-lead.service";

function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    rows,
    travelLead: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
        if (where.idempotencyKey) return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
        if (where.id) return rows.find((row) => row.id === where.id) ?? null;
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.reference === data.reference)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: { target: ["reference"] }
          });
        }
        if (data.idempotencyKey && rows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: { target: ["idempotency_key"] }
          });
        }
        counter += 1;
        const row = { id: `lead-${counter}`, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      })
    }
  };
}

function baseInput(overrides: Partial<CreateInternalLeadInput> = {}): CreateInternalLeadInput {
  return {
    organizationId: "org-1",
    pluginInstallationId: "plugin-1",
    conversationId: "conversation-1",
    phoneNumber: "+919876543210",
    conversationSummary: "Delhi -> London enquiry",
    ...overrides
  };
}

describe("TravelLeadService.createInternalLead", () => {
  it("stamps consentGivenAt and a PENDING crmSyncStatus on every new lead", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const lead = await service.createInternalLead(baseInput());
    expect(lead.consentGivenAt).toBeInstanceOf(Date);
    expect(lead.crmSyncStatus).toBe("PENDING");
    expect(lead.reference).toMatch(/^TRV-/);
  });

  it("never requires every optional journey field — only phoneNumber and conversationSummary", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    await expect(service.createInternalLead(baseInput())).resolves.toMatchObject({
      phoneNumber: "+919876543210",
      journeyId: null,
      destination: null,
      budgetAmount: null
    });
  });

  it("duplicate phone submission in the SAME conversation collapses onto one lead (idempotency key)", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const first = await service.createInternalLead(baseInput());
    const second = await service.createInternalLead(baseInput());
    expect(second.id).toBe(first.id);
    expect(prisma.rows).toHaveLength(1);
  });

  it("a repeated 'ji'/'haan' style resubmission (same conversation, same journey) never creates a duplicate lead", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    await service.createInternalLead(baseInput({ journeyId: "journey-1" }));
    await service.createInternalLead(baseInput({ journeyId: "journey-1" }));
    await service.createInternalLead(baseInput({ journeyId: "journey-1" }));
    expect(prisma.rows).toHaveLength(1);
  });

  it("a duplicate runtime retry (identical inputs, concurrent-style re-invocation) still resolves to a single lead", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const [first, second] = await Promise.all([
      service.createInternalLead(baseInput()),
      service.createInternalLead(baseInput())
    ]);
    // Whichever request's create() call the fake Prisma processed first wins; the other must resolve to the
    // SAME row (via the idempotency-key P2002 recovery path), never throw and never create a second row.
    expect(first.id).toBe(second.id);
    expect(prisma.rows).toHaveLength(1);
  });

  it("a genuinely new journey (a different journeyId) creates a separate lead, not suppressed by idempotency", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const first = await service.createInternalLead(baseInput({ journeyId: "journey-1" }));
    const second = await service.createInternalLead(baseInput({ journeyId: "journey-2" }));
    expect(second.id).not.toBe(first.id);
    expect(prisma.rows).toHaveLength(2);
  });

  it("a different conversation (same organization) also creates a separate lead", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const first = await service.createInternalLead(baseInput({ conversationId: "conversation-1" }));
    const second = await service.createInternalLead(baseInput({ conversationId: "conversation-2" }));
    expect(second.id).not.toBe(first.id);
  });

  it("tenant isolation: two organizations with the same conversationId never collide on the same idempotency key or lead", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const tenantA = await service.createInternalLead(
      baseInput({ organizationId: "org-A", conversationId: "shared-conversation-id" })
    );
    const tenantB = await service.createInternalLead(
      baseInput({ organizationId: "org-B", conversationId: "shared-conversation-id" })
    );
    expect(tenantA.id).not.toBe(tenantB.id);
    expect(tenantA.organizationId).toBe("org-A");
    expect(tenantB.organizationId).toBe("org-B");
    expect(
      service.buildIdempotencyKey("org-A", "shared-conversation-id")
    ).not.toBe(service.buildIdempotencyKey("org-B", "shared-conversation-id"));
  });

  it("retries once with a freshly generated reference on a plain reference collision (not an idempotency-key collision)", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    await service.createInternalLead(baseInput({ conversationId: "conversation-1" }));
    // Force a reference collision on the second, otherwise-independent lead by pre-seeding the same
    // reference the generator would need to avoid.
    const existingReference = prisma.rows[0]?.reference as string;
    const created = prisma.travelLead.create;
    let attempt = 0;
    prisma.travelLead.create = vi.fn(async (args: { data: Record<string, unknown> }) => {
      attempt += 1;
      if (attempt === 1) args.data.reference = existingReference;
      return created(args);
    });
    const second = await service.createInternalLead(baseInput({ conversationId: "conversation-2" }));
    expect(second.reference).not.toBe(existingReference);
    expect(prisma.rows).toHaveLength(2);
  });

  it("multi-city lead summary: the destination field carries the COMPLETE route, not just the active leg", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const lead = await service.createInternalLead(
      baseInput({
        journeyId: "journey-multi",
        destination: "Delhi -> London -> New York -> Delhi",
        departureCity: "Delhi",
        conversationSummary: "Leg 1: Delhi -> London | Leg 2: London -> New York | Leg 3: New York -> Delhi"
      })
    );
    expect(lead.destination).toBe("Delhi -> London -> New York -> Delhi");
    expect(lead.conversationSummary).toContain("Leg 1: Delhi -> London");
    expect(lead.conversationSummary).toContain("Leg 3: New York -> Delhi");
  });
});

describe("TravelLeadService.markCrmSyncStatus", () => {
  it("updates the row's crmSyncStatus and never throws even if the update fails", async () => {
    const prisma = fakePrisma();
    const service = new TravelLeadService(prisma as unknown as PrismaService);
    const lead = await service.createInternalLead(baseInput());
    await service.markCrmSyncStatus(lead.id, "SYNCED" as never);
    expect(prisma.rows[0]?.crmSyncStatus).toBe("SYNCED");

    prisma.travelLead.update = vi.fn().mockRejectedValue(new Error("row deleted"));
    await expect(service.markCrmSyncStatus(lead.id, "FAILED" as never)).resolves.toBeUndefined();
  });
});
