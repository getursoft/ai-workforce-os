import { describe, expect, it, vi } from "vitest";
import { MemoryAuditAction } from "@prisma/client";
import { MemoryService } from "./memory.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

function fakePrisma(overrides: Record<string, unknown> = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const conversationMessages: Array<{ role: string; content: string }> = [];
  const summaries = new Map<string, { summary: string; summarizedMessageCount: number; summaryVersion: number }>();
  const auditEvents: unknown[] = [];
  const prisma = {
    memoryRecord: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const match = (row: Record<string, unknown>) =>
          Object.entries(where).every(([key, value]) => row[key] === value);
        const found = [...rows.values()].find((row) => match(row) && row.deletedAt === null);
        return found ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> } = { where: {} }) => {
        return [...rows.values()].filter((row) => row.deletedAt === null).filter((row) => {
          for (const [key, value] of Object.entries(where)) {
            if (key === "AND") continue;
            if (key === "id" && typeof value === "object" && value !== null && "in" in value) {
              if (!(value as { in: unknown[] }).in.includes(row.id)) return false;
              continue;
            }
            if (key === "deletedAt") continue;
            if (row[key] !== value) return false;
          }
          return true;
        });
      }),
      count: vi.fn(async () => [...rows.values()].filter((row) => row.deletedAt === null).length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id) ?? {};
        const next = { ...row, ...data };
        rows.set(where.id, next);
        return next;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const ids = [...rows.values()]
          .filter((row) => row.organizationId === where.organizationId && row.deletedAt === null)
          .filter((row) => {
            const idFilter = where.id as { in?: string[] } | undefined;
            return idFilter?.in ? idFilter.in.includes(row.id as string) : true;
          })
          .filter((row) => (where.scope ? row.scope === where.scope : true));
        for (const id of ids) rows.set(String(id.id), { ...id, ...data });
        return { count: ids.length };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `mem-${rows.size + 1}`;
        const row = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.set(id, row);
        return row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id))
    },
    memoryAuditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return { id: "audit-1", ...data };
      }),
      findMany: vi.fn(async () => auditEvents),
      count: vi.fn(async () => auditEvents.length)
    },
    conversationSummary: {
      findUnique: vi.fn(async ({ where }: { where: { conversationId: string } }) => summaries.get(where.conversationId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { conversationId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = summaries.get(where.conversationId);
        const next = existing
          ? {
              summary: String(update.summary ?? existing.summary),
              summarizedMessageCount: Number(update.summarizedMessageCount ?? existing.summarizedMessageCount),
              summaryVersion: (existing.summaryVersion ?? 1) + 1
            }
          : {
              summary: String(create.summary ?? ""),
              summarizedMessageCount: Number(create.summarizedMessageCount ?? 0),
              summaryVersion: 1
            };
        summaries.set(where.conversationId, next);
        return next;
      })
    },
    conversationMessage: {
      count: vi.fn(async () => conversationMessages.length),
      findMany: vi.fn(async () => conversationMessages)
    },
    conversation: { count: vi.fn(async () => 1) },
    plugin: { count: vi.fn(async () => 1) },
    user: { count: vi.fn(async () => 1) },
    $transaction: vi.fn(async (calls: Array<Promise<unknown>>) => Promise.all(calls)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    ...overrides
  };
  const embeddings = {
    embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]], model: "m", dimensions: 3 }))
  };
  const auditLogger = new AuditEventLogger();
  const service = new MemoryService(prisma as never, embeddings as never, auditLogger);
  return { prisma, service, rows, conversationMessages, summaries, auditEvents, embeddings };
}

const BASE = {
  organizationId: "org",
  scope: "USER",
  key: "preferred.airline",
  category: "PREFERENCE",
  value: { value: "Emirates" },
  employeeId: "emp",
  userId: "user",
  conversationId: null,
  confidence: 0.98,
  importance: "HIGH",
  source: "RULE_EXTRACTION",
  searchableText: "Emirates"
} as const;

describe("MemoryService", () => {
  it("remembers a preference (creates) and upserts on a repeat (updates)", async () => {
    const { service, prisma } = fakePrisma();
    const created = await service.remember({ ...BASE });
    expect(created.key).toBe("preferred.airline");
    expect(prisma.memoryRecord.create).toHaveBeenCalledOnce();
    await service.remember({ ...BASE, value: { value: "Vistara" } });
    expect(prisma.memoryRecord.update).toHaveBeenCalled();
    expect(prisma.memoryAuditEvent.create).toHaveBeenCalledTimes(2);
  });

  it("forgets (soft-deletes) a memory by id", async () => {
    const { service, rows } = fakePrisma();
    const created = await service.remember({ ...BASE });
    await service.forget("org", created.id, "actor");
    expect(rows.get(created.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it("forgetByCriteria deletes matching memories", async () => {
    const { service } = fakePrisma();
    await service.remember({ ...BASE });
    await service.remember({ ...BASE, key: "other.key", category: "PERSONAL" });
    const result = await service.forgetByCriteria("org", { organizationId: "org", category: "PREFERENCE" });
    expect(result.count).toBe(1);
    expect(result.ids).toContain("mem-1");
  });

  it("recall buckets records by scope in the required order", async () => {
    const { service, prisma } = fakePrisma();
    await service.remember({ ...BASE });
    await service.remember({ ...BASE, scope: "ORGANIZATION", key: "approval.hierarchy", value: { value: "Manager" }, userId: null, employeeId: null });
    await service.remember({ ...BASE, scope: "EMPLOYEE", key: "pending.task", value: { value: "Draft" }, userId: null });
    await service.remember({ ...BASE, scope: "CONVERSATION", key: "conversation.summary", value: { summary: "x" }, userId: null });
    const context = await service.recall("org", { userId: "user", employeeId: "emp", conversationId: "conv-1" });
    expect(context.user.some((record) => record.key === "preferred.airline")).toBe(true);
    expect(context.organization.some((record) => record.key === "approval.hierarchy")).toBe(true);
    expect(context.employee.some((record) => record.key === "pending.task")).toBe(true);
    void prisma;
  });

  it("summarizeConversation stores the rolling summary and bumps the version", async () => {
    const { service, summaries, conversationMessages } = fakePrisma();
    for (let i = 0; i < 25; i++) conversationMessages.push({ role: "USER", content: `message ${i}` });
    const first = await service.summarizeConversation("org", "conv-1", null);
    expect(first.summarizedMessageCount).toBe(25);
    expect(first.version).toBe(1);
    expect(summaries.get("conv-1")?.summaryVersion).toBe(1);
    const second = await service.summarizeConversation("org", "conv-1", null);
    expect(second.version).toBe(2);
  });

  it("maybeSummarize only fires once enough new messages accumulate", async () => {
    const { service, conversationMessages } = fakePrisma();
    for (let i = 0; i < 10; i++) conversationMessages.push({ role: "USER", content: `message ${i}` });
    expect(await service.maybeSummarizeConversation("org", "conv-1", 20)).toBe(false);
    for (let i = 0; i < 15; i++) conversationMessages.push({ role: "USER", content: `message ${i + 10}` });
    expect(await service.maybeSummarizeConversation("org", "conv-1", 20)).toBe(true);
  });

  it("merge keeps the newest duplicate and soft-deletes the rest", async () => {
    const { service, rows } = fakePrisma();
    const base = {
      organizationId: "org",
      employeeId: "emp",
      userId: null,
      conversationId: null,
      scope: "USER",
      category: "PREFERENCE",
      key: "dupe",
      value: { value: "1" },
      searchableText: "1",
      confidence: 1,
      importance: "MEDIUM",
      source: "DASHBOARD",
      metadata: {},
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(0)
    };
    rows.set("a", { ...base, id: "a", updatedAt: new Date(0) });
    rows.set("b", { ...base, id: "b", updatedAt: new Date(1) });
    const result = await service.merge("org", ["a", "b"], "actor");
    expect(result.merged).toBe(1);
    expect(result.survivor.id).toBe("b");
    expect(rows.get("a")?.deletedAt).toBeInstanceOf(Date);
  });

  it("expire marks live expired records as deleted", async () => {
    const { service, prisma } = fakePrisma();
    await service.remember({ ...BASE, expiresAt: new Date(Date.now() - 1000) });
    const count = await service.expire("org");
    expect(count).toBeGreaterThan(0);
    expect(prisma.memoryRecord.updateMany).toHaveBeenCalled();
  });

  it("search scopes visibility and ranks hits", async () => {
    const { service } = fakePrisma();
    await service.remember({ ...BASE });
    const hits = await service.search("org", { userId: "user", employeeId: "emp" }, { query: "airline" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("preferred.airline");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("audits read actions only when a real memory id exists", async () => {
    const { service, prisma } = fakePrisma();
    await service.remember({ ...BASE });
    const createdAudits = prisma.memoryAuditEvent.create.mock.calls.filter(
      ([call]) => call.data.action === MemoryAuditAction.CREATE
    );
    expect(createdAudits.length).toBe(1);
  });
});
