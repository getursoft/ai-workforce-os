import { describe, expect, it } from "vitest";
import type { MemoryContext } from "./memory.types";
import { buildMemoryContextBlock, formatMemoryContextBlock } from "./memory.prompt";

function context(partial: Partial<MemoryContext> = {}): MemoryContext {
  return {
    organization: [],
    employee: [],
    user: [],
    conversationSummary: null,
    conversationSummaryVersion: null,
    ...partial
  };
}

describe("memory prompt block", () => {
  it("returns an empty block when nothing was retrieved", () => {
    expect(buildMemoryContextBlock(context())).toEqual([]);
    expect(formatMemoryContextBlock(context())).toBe("");
  });

  it("orders Organization -> Employee -> User -> Conversation Summary", () => {
    const block = buildMemoryContextBlock(
      context({
        organization: [
          {
            id: "o1",
            organizationId: "org",
            employeeId: null,
            userId: null,
            conversationId: null,
            scope: "ORGANIZATION",
            category: "POLICY",
            key: "approval.hierarchy",
            value: { value: "Manager then Finance" },
            searchableText: "Manager then Finance",
            confidence: 1,
            importance: "HIGH",
            source: "DASHBOARD",
            metadata: {},
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
          }
        ],
        employee: [
          {
            id: "e1",
            organizationId: "org",
            employeeId: "emp",
            userId: null,
            conversationId: null,
            scope: "EMPLOYEE",
            category: "WORK",
            key: "pending.task",
            value: { value: "Draft itinerary" },
            searchableText: "Draft itinerary",
            confidence: 1,
            importance: "HIGH",
            source: "SYSTEM",
            metadata: {},
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
          }
        ],
        user: [
          {
            id: "u1",
            organizationId: "org",
            employeeId: "emp",
            userId: "user",
            conversationId: null,
            scope: "USER",
            category: "PREFERENCE",
            key: "food.preference",
            value: { value: "Vegetarian" },
            searchableText: "Vegetarian",
            confidence: 0.99,
            importance: "HIGH",
            source: "RULE_EXTRACTION",
            metadata: {},
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
          }
        ],
        conversationSummary: "User prefers Emirates and vegetarian food."
      })
    );
    expect(block.join("\n")).toContain("Organization memory");
    expect(block.join("\n")).toContain("Employee memory");
    expect(block.join("\n")).toContain("User memory");
    expect(block.join("\n")).toContain("Conversation summary");
    const order = block.join("\n").indexOf("Organization memory");
    const employeeAt = block.join("\n").indexOf("Employee memory");
    const userAt = block.join("\n").indexOf("User memory");
    const summaryAt = block.join("\n").indexOf("Conversation summary");
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(employeeAt);
    expect(employeeAt).toBeLessThan(userAt);
    expect(userAt).toBeLessThan(summaryAt);
  });

  it("includes importance labels and values", () => {
    const block = buildMemoryContextBlock(
      context({
        user: [
          {
            id: "u1",
            organizationId: "org",
            employeeId: null,
            userId: "u",
            conversationId: null,
            scope: "USER",
            category: "PREFERENCE",
            key: "preferred.airline",
            value: { value: "Emirates" },
            searchableText: "Emirates",
            confidence: 1,
            importance: "CRITICAL",
            source: "RULE_EXTRACTION",
            metadata: {},
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
          }
        ]
      })
    );
    const joined = block.join("\n");
    expect(joined).toContain("preferred.airline: Emirates");
    expect(joined).toContain("(CRITICAL)");
  });
});
