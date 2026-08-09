import { describe, expect, it } from "vitest";
import type { SkillExecutionContext } from "@ai-workforce-os/skill-sdk";
import { EntityExtractionSkill } from "./entity-extraction.skill";
import { SkillError } from "../skill-error";

function makeContext(overrides: Partial<SkillExecutionContext> = {}): SkillExecutionContext {
  return {
    organizationId: "org-1",
    grantedPermissions: new Set(["skill.execute"]),
    grantedCapabilities: new Set(["ai.provider.execute"]),
    configuration: {},
    idempotencyKey: "test-key",
    capabilities: {},
    ...overrides
  };
}

describe("EntityExtractionSkill", () => {
  const skill = new EntityExtractionSkill();

  it("rejects empty text", async () => {
    await expect(skill.validate({ text: "", entitySchema: { name: "string" } })).rejects.toThrow(SkillError);
  });

  it("rejects an empty entitySchema", async () => {
    await expect(skill.validate({ text: "hello", entitySchema: {} })).rejects.toThrow(SkillError);
  });

  it("rejects an unsupported declared entity type", async () => {
    await expect(
      skill.validate({ text: "hello", entitySchema: { field: "array" as never } })
    ).rejects.toThrow(SkillError);
  });

  it("extracts entities using the AI capability when granted, parsing structured JSON output", async () => {
    const context = makeContext({
      capabilities: {
        ai: {
          complete: async () => ({
            content: JSON.stringify({ entities: { invoiceNumber: "INV-42", totalAmount: 199.5 }, confidence: 0.92 }),
            provider: "test-provider",
            model: "test-model"
          })
        }
      }
    });
    const result = await skill.execute(
      { text: "Invoice INV-42 for $199.50", entitySchema: { invoiceNumber: "string", totalAmount: "number" } },
      context
    );
    expect(result.data.entities).toEqual({ invoiceNumber: "INV-42", totalAmount: 199.5 });
    expect(result.data.confidence).toBe(0.92);
    expect(result.data.warnings).toEqual([]);
  });

  it("only fills fields declared in the schema, never inventing extra fields from a noisy AI response", async () => {
    const context = makeContext({
      capabilities: {
        ai: {
          complete: async () => ({
            content: JSON.stringify({ entities: { name: "Alice", extraUnrequestedField: "should be dropped" }, confidence: 0.8 }),
            provider: "p",
            model: "m"
          })
        }
      }
    });
    const result = await skill.execute({ text: "Alice", entitySchema: { name: "string" } }, context);
    expect(result.data.entities).toEqual({ name: "Alice" });
    expect(Object.keys(result.data.entities)).not.toContain("extraUnrequestedField");
  });

  it("falls back to deterministic best-effort extraction when no AI capability is granted", async () => {
    const context = makeContext({ grantedCapabilities: new Set(), capabilities: {} });
    const result = await skill.execute(
      { text: "Due on 2026-08-15 for 42 units", entitySchema: { dueDate: "date", quantity: "number" } },
      context
    );
    expect(result.data.entities.dueDate).toBe("2026-08-15");
    expect(result.data.entities.quantity).toBe(42);
    expect(result.data.warnings.length).toBeGreaterThan(0);
  });

  it("falls back to deterministic extraction when the AI provider throws, without failing the turn", async () => {
    const context = makeContext({
      capabilities: {
        ai: {
          complete: async () => {
            throw new Error("provider unavailable");
          }
        }
      }
    });
    const result = await skill.execute({ text: "no numbers or dates here", entitySchema: { name: "string" } }, context);
    expect(result.data.entities.name).toBeNull();
    expect(result.data.warnings.length).toBeGreaterThan(0);
  });

  it("health reports HEALTHY", async () => {
    const health = await skill.health();
    expect(health.status).toBe("HEALTHY");
  });
});
