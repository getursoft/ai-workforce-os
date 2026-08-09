import { describe, expect, it } from "vitest";
import type { SkillExecutionContext } from "@ai-workforce-os/skill-sdk";
import {
  TranslationSkill,
  AiProviderTranslationAdapter,
  DeterministicTranslationAdapter
} from "./translation.skill";
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

describe("TranslationSkill", () => {
  const skill = new TranslationSkill();

  it("rejects empty text and missing targetLanguage", async () => {
    await expect(skill.validate({ text: "", targetLanguage: "fr" })).rejects.toThrow(SkillError);
    await expect(skill.validate({ text: "hi", targetLanguage: "" })).rejects.toThrow(SkillError);
  });

  it("uses the AI adapter when the ai capability is granted", async () => {
    const context = makeContext({
      capabilities: {
        ai: {
          complete: async () => ({
            content: JSON.stringify({ translatedText: "Bonjour", detectedSourceLanguage: "en" }),
            provider: "test-provider",
            model: "test-model"
          })
        }
      }
    });
    const result = await skill.execute({ text: "Hello", targetLanguage: "fr" }, context);
    expect(result.data.translatedText).toBe("Bonjour");
    expect(result.data.sourceLanguage).toBe("en");
    expect(result.data.targetLanguage).toBe("fr");
    expect(result.data.model).toBe("test-model");
  });

  it("falls back to the deterministic adapter when no AI capability is granted (required offline adapter)", async () => {
    const context = makeContext({ grantedCapabilities: new Set(), capabilities: {} });
    const result = await skill.execute({ text: "Hello", targetLanguage: "fr" }, context);
    expect(result.data.translatedText).toBe("[fr] Hello");
    expect(result.data.model).toBeNull();
  });

  it("falls back to the deterministic adapter when the AI provider throws, without failing the turn", async () => {
    const context = makeContext({
      capabilities: {
        ai: {
          complete: async () => {
            throw new Error("provider down");
          }
        }
      }
    });
    const result = await skill.execute({ text: "Hello", targetLanguage: "de" }, context);
    expect(result.data.translatedText).toBe("[de] Hello");
  });

  describe("DeterministicTranslationAdapter (required test/offline adapter)", () => {
    it("is stable and reversible-tagged, requiring no network or AI provider", async () => {
      const adapter = new DeterministicTranslationAdapter();
      const result = await adapter.translate({ text: "Test input", targetLanguage: "es" }, makeContext());
      expect(result.translatedText).toBe("[es] Test input");
      expect(result.model).toBeNull();
    });
  });

  describe("AiProviderTranslationAdapter", () => {
    it("throws when the ai capability is not present on the context", async () => {
      const adapter = new AiProviderTranslationAdapter();
      await expect(
        adapter.translate({ text: "hi", targetLanguage: "fr" }, makeContext({ capabilities: {} }))
      ).rejects.toThrow(SkillError);
    });
  });

  it("health reports HEALTHY", async () => {
    const health = await skill.health();
    expect(health.status).toBe("HEALTHY");
  });
});
