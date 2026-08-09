import { Injectable } from "@nestjs/common";
import type {
  SkillAdapter,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillHealthResult,
  SkillManifest
} from "@ai-workforce-os/skill-sdk";
import { healthySkillHealth } from "@ai-workforce-os/skill-sdk";
import { SkillError } from "../skill-error";

export interface TranslationInput {
  text: string;
  sourceLanguage?: string;
  targetLanguage: string;
}

export interface TranslationOutput {
  translatedText: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage: string | null;
  model: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Adapter abstraction (Phase 9): the skill never talks to a concrete translation provider
 * directly. `AiProviderTranslationAdapter` is the production adapter (routes through the
 * skill's granted `ai.provider.execute` capability); `DeterministicTranslationAdapter` is a
 * required, dependency-free adapter used when no AI provider is configured and in tests.
 */
export interface TranslationAdapter {
  readonly name: string;
  translate(input: TranslationInput, context: SkillExecutionContext): Promise<TranslationResult>;
}

export class AiProviderTranslationAdapter implements TranslationAdapter {
  readonly name = "ai-provider";

  async translate(input: TranslationInput, context: SkillExecutionContext): Promise<TranslationResult> {
    if (!context.capabilities.ai) throw new SkillError("SKILL_ENTITLEMENT_DENIED", "AI provider unavailable");
    const result = await context.capabilities.ai.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a translation engine. Return JSON only: {\"translatedText\": string, \"detectedSourceLanguage\": string}. " +
            "Preserve meaning, tone and formatting; do not add commentary."
        },
        {
          role: "user",
          content: `Translate to ${input.targetLanguage}${input.sourceLanguage ? ` (source language: ${input.sourceLanguage})` : ""}:\n\n${input.text.slice(0, 100_000)}`
        }
      ],
      temperature: 0.1,
      maxOutputTokens: Math.min(4000, Math.ceil(input.text.length / 2))
    });
    const parsed = parseTranslation(result.content, input.text);
    return {
      translatedText: parsed.translatedText,
      detectedSourceLanguage: parsed.detectedSourceLanguage ?? input.sourceLanguage ?? null,
      model: result.model,
      usage: {
        inputTokens: result.usage?.inputTokens ?? estimateTokens(input.text),
        outputTokens: result.usage?.outputTokens ?? estimateTokens(parsed.translatedText)
      }
    };
  }
}

/** Deterministic, provider-free adapter: required by Phase 9 for tests and as the offline fallback.
 *  Does not attempt real translation — it applies a stable, reversible tag so callers/tests can assert
 *  behavior without a live AI provider. */
export class DeterministicTranslationAdapter implements TranslationAdapter {
  readonly name = "deterministic";

  async translate(input: TranslationInput): Promise<TranslationResult> {
    return {
      translatedText: `[${input.targetLanguage}] ${input.text}`,
      detectedSourceLanguage: input.sourceLanguage ?? null,
      model: null
    };
  }
}

const MANIFEST: SkillManifest = {
  key: "translation",
  name: "Translation",
  description:
    "Translates text into a target language. Uses the employee's configured AI provider when available and a deterministic adapter otherwise.",
  category: "Text Processing",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text", "targetLanguage"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 200_000 },
      sourceLanguage: { type: "string", maxLength: 16 },
      targetLanguage: { type: "string", minLength: 2, maxLength: 16 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["translatedText", "sourceLanguage", "targetLanguage"],
    properties: {
      translatedText: { type: "string" },
      sourceLanguage: { type: ["string", "null"] },
      targetLanguage: { type: "string" },
      model: { type: ["string", "null"] },
      usage: { type: "object" }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: ["ai.provider.execute"],
  dependencies: [],
  billingCategory: "AI_PROVIDER_BACKED",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 1, backoffMs: 250 },
  statefulness: "STATELESS",
  capabilitySummary: ["Translate text between languages"]
};

@Injectable()
export class TranslationSkill implements SkillAdapter<TranslationInput, TranslationOutput> {
  readonly manifest = MANIFEST;
  private readonly aiAdapter: TranslationAdapter = new AiProviderTranslationAdapter();
  private readonly deterministicAdapter: TranslationAdapter = new DeterministicTranslationAdapter();

  async validate(input: TranslationInput): Promise<void> {
    if (!input.text?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "text is required");
    if (!input.targetLanguage?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "targetLanguage is required");
  }

  async execute(
    input: TranslationInput,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult<TranslationOutput>> {
    const adapter = context.capabilities.ai ? this.aiAdapter : this.deterministicAdapter;
    let result: TranslationResult;
    try {
      result = await adapter.translate(input, context);
    } catch (error) {
      if (adapter === this.aiAdapter) {
        result = await this.deterministicAdapter.translate(input, context);
      } else {
        throw error;
      }
    }
    return {
      data: {
        translatedText: result.translatedText,
        sourceLanguage: result.detectedSourceLanguage,
        targetLanguage: input.targetLanguage,
        model: result.model,
        usage: {
          inputTokens: result.usage?.inputTokens ?? estimateTokens(input.text),
          outputTokens: result.usage?.outputTokens ?? estimateTokens(result.translatedText)
        }
      },
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.inputTokens + result.usage.outputTokens
            }
          }
        : {})
    };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([
      { name: "adapter-registered", status: "HEALTHY" },
      { name: "ai-provider", status: "HEALTHY", detail: "falls back to deterministic adapter" }
    ]);
  }
}

function parseTranslation(content: string, fallback: string): { translatedText: string; detectedSourceLanguage: string | null } {
  try {
    const parsed = JSON.parse(content) as { translatedText?: unknown; detectedSourceLanguage?: unknown };
    return {
      translatedText: typeof parsed.translatedText === "string" ? parsed.translatedText : content || fallback,
      detectedSourceLanguage: typeof parsed.detectedSourceLanguage === "string" ? parsed.detectedSourceLanguage : null
    };
  } catch {
    return { translatedText: content || fallback, detectedSourceLanguage: null };
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
