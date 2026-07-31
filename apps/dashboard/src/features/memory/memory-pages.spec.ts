import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "./memory-api";
import { formatValue, scopeLabel } from "./memory-pages";

function record(value: unknown): MemoryRecord {
  return {
    id: "mem-1",
    organizationId: "org",
    employeeId: null,
    userId: null,
    conversationId: null,
    scope: "USER",
    category: "PREFERENCE",
    key: "preferred.airline",
    value: value as Record<string, unknown>,
    searchableText: null,
    confidence: 0.98,
    importance: "HIGH",
    source: "RULE_EXTRACTION",
    metadata: {},
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null
  };
}

describe("memory page helpers", () => {
  it("labels the four scope tabs", () => {
    expect(scopeLabel("USER")).toBe("User Memory");
    expect(scopeLabel("ORGANIZATION")).toBe("Organization Memory");
    expect(scopeLabel("EMPLOYEE")).toBe("Employee Memory");
    expect(scopeLabel("CONVERSATION")).toBe("Conversation Memory");
  });

  it("formats primitive and nested values", () => {
    expect(formatValue(record({ value: "Emirates" }))).toBe("Emirates");
    expect(formatValue(record("raw"))).toBe("raw");
    expect(formatValue(record(42))).toBe("42");
    expect(formatValue(record({ nested: { deep: true } }))).toBe('{"nested":{"deep":true}}');
  });
});
