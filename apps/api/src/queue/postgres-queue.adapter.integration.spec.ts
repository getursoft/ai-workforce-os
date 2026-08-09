import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { deleteAllOrganizationScopedRows } from "../test/cleanup";
import { PostgresQueueAdapter } from "./postgres-queue.adapter";
import { QueueConsumerWorker, QueueHandlerRegistry, QueueHealthService } from "./queue-worker";

for (const candidate of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = testDatabaseUrl ? new URL(testDatabaseUrl).pathname.slice(1) : null;
if (testDatabaseUrl && databaseName !== "ai_workforce_os_test") {
  throw new Error("Integration tests refuse to run outside ai_workforce_os_test");
}
const integration = testDatabaseUrl ? describe : describe.skip;
const prisma = testDatabaseUrl ? new PrismaService({ datasourceUrl: testDatabaseUrl }) : null;

function client(): PrismaService {
  if (!prisma) throw new Error("PrismaService not initialized — TEST_DATABASE_URL missing");
  return prisma;
}

/**
 * Sprint 5.0 Phase 4: the durable queue's core correctness properties, exercised against real Postgres —
 * unit tests with mocked Prisma can't meaningfully verify atomic claim semantics, since the whole point
 * of `claim()`'s conditional UPDATE is to be safe under real concurrent access. This is also the first
 * real end-to-end proof (publish → claim → handle → complete, and the retry/dead-letter/recover paths)
 * that the queue infrastructure fixed in this pass (worker-ownership guard, DI token wiring) actually
 * works, not just compiles.
 */
integration("PostgresQueueAdapter (integration)", () => {
  let organizationId: string;

  beforeEach(async () => {
    const db = client();
    await deleteAllOrganizationScopedRows(db);
    const org = await db.organization.create({
      data: { name: `Queue Test Org ${Date.now()}`, slug: `queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, status: "ACTIVE" }
    });
    organizationId = org.id;
  });

  afterAll(async () => {
    if (prisma) {
      await deleteAllOrganizationScopedRows(prisma);
      await prisma.$disconnect();
    }
  });

  it("publish is idempotent on dedupeKey — a second publish with the same key returns the original message, not a duplicate", async () => {
    const adapter = new PostgresQueueAdapter(client());
    const first = await adapter.publish({ organizationId, category: "NOTIFICATION_JOBS", refType: "test", refId: "a", dedupeKey: "dedupe-1" });
    const second = await adapter.publish({ organizationId, category: "NOTIFICATION_JOBS", refType: "test", refId: "a", dedupeKey: "dedupe-1" });
    expect(first?.id).toBe(second?.id);
    const all = await client().queueMessage.findMany({ where: { organizationId, category: "NOTIFICATION_JOBS" } });
    expect(all).toHaveLength(1);
  });

  it("claim atomically hands each message to exactly one of several concurrent claimers — no double-claim", async () => {
    const adapter = new PostgresQueueAdapter(client());
    for (let i = 0; i < 10; i++) {
      await adapter.publish({ organizationId, category: "DOCUMENT_PROCESSING", refType: "doc", refId: `doc-${i}` });
    }
    const [a, b, c] = await Promise.all([
      adapter.claim({ workerId: "worker-a", limit: 10 }),
      adapter.claim({ workerId: "worker-b", limit: 10 }),
      adapter.claim({ workerId: "worker-c", limit: 10 })
    ]);
    const claimedIds = [...a.claimed, ...b.claimed, ...c.claimed].map((m) => m.id);
    expect(claimedIds).toHaveLength(10);
    expect(new Set(claimedIds).size).toBe(10); // no id claimed twice across the three concurrent claimers
  });

  it("complete only succeeds for the worker that actually holds the claim", async () => {
    const adapter = new PostgresQueueAdapter(client());
    const message = await adapter.publish({ organizationId, category: "RETENTION_JOBS", refType: "sweep", refId: "1" });
    if (!message) throw new Error("publish returned null");
    await adapter.claim({ workerId: "worker-real", limit: 10 });

    expect(await adapter.complete(message.id, "worker-impostor")).toBe(false);
    expect(await adapter.complete(message.id, "worker-real")).toBe(true);
    const row = await client().queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe("COMPLETED");
  });

  it("fail() retries with backoff until maxAttempts, then dead-letters — never silently drops the message", async () => {
    const adapter = new PostgresQueueAdapter(client());
    const message = await adapter.publish({ organizationId, category: "DELIVERY_RETRIES", refType: "msg", refId: "1", maxAttempts: 2 });
    if (!message) throw new Error("publish returned null");

    const claim1 = await adapter.claim({ workerId: "worker-1", limit: 10 });
    expect(claim1.claimed).toHaveLength(1);
    await adapter.fail(message.id, "worker-1", { errorCode: "TRANSIENT", errorMessage: "first attempt failed", retryDelayMs: 1 });
    const afterFirstFail = await client().queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(afterFirstFail.status).toBe("RETRYING");

    await new Promise((r) => setTimeout(r, 5));
    const claim2 = await adapter.claim({ workerId: "worker-2", limit: 10 });
    expect(claim2.claimed).toHaveLength(1);
    await adapter.fail(message.id, "worker-2", { errorCode: "TRANSIENT", errorMessage: "second attempt also failed", retryDelayMs: 1 });
    const afterSecondFail = await client().queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(afterSecondFail.status).toBe("DEAD_LETTERED");
    expect(afterSecondFail.errorMessage).toContain("second attempt");
  });

  it("recover() reclaims a message whose visibility lease has already elapsed, so a crashed worker never wedges it forever", async () => {
    const adapter = new PostgresQueueAdapter(client());
    const message = await adapter.publish({ organizationId, category: "WORKFORCE_TASKS", refType: "task", refId: "1", visibilityMs: 1 });
    if (!message) throw new Error("publish returned null");
    await adapter.claim({ workerId: "worker-crashed", limit: 10 });
    await new Promise((r) => setTimeout(r, 5));

    const recovered = await adapter.recover();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const row = await client().queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe("QUEUED");
    expect(row.workerId).toBeNull();
  });

  it("end-to-end via QueueConsumerWorker: a published message reaches its registered handler and is marked COMPLETED", async () => {
    const db = client();
    const adapter = new PostgresQueueAdapter(db);
    const registry = new QueueHandlerRegistry();
    const handled: string[] = [];
    registry.register("SCHEDULER_JOBS", async (message) => {
      handled.push(message.refId);
      return true;
    });
    const worker = new QueueConsumerWorker(adapter, registry);

    const message = await adapter.publish({ organizationId, category: "SCHEDULER_JOBS", refType: "job", refId: "job-42" });
    if (!message) throw new Error("publish returned null");

    const processed = await worker.processOnce("e2e-worker", 10);
    expect(processed).toBe(1);
    expect(handled).toEqual(["job-42"]);
    const row = await db.queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe("COMPLETED");
  });

  it("end-to-end: a handler that returns false triggers a retry, not silent success", async () => {
    const db = client();
    const adapter = new PostgresQueueAdapter(db);
    const registry = new QueueHandlerRegistry();
    registry.register("CHANNEL_MESSAGES", async () => false);
    const worker = new QueueConsumerWorker(adapter, registry);

    const message = await adapter.publish({ organizationId, category: "CHANNEL_MESSAGES", refType: "msg", refId: "1" });
    if (!message) throw new Error("publish returned null");
    await worker.processOnce("e2e-worker", 10);

    const row = await db.queueMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(["RETRYING", "DEAD_LETTERED"]).toContain(row.status);
    expect(row.errorCode).toBe("HANDLER_REJECTED");
  });

  it("QueueHealthService reports DEGRADED when there are stale claims", async () => {
    const db = client();
    const adapter = new PostgresQueueAdapter(db);
    const health = new QueueHealthService(adapter);
    const message = await adapter.publish({ organizationId, category: "NOTIFICATION_JOBS", refType: "n", refId: "1", visibilityMs: 1 });
    if (!message) throw new Error("publish returned null");
    await adapter.claim({ workerId: "worker-1", limit: 10 });
    await new Promise((r) => setTimeout(r, 5));

    const snapshot = await health.snapshot();
    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.health.staleClaims).toBeGreaterThanOrEqual(1);
  });
});
