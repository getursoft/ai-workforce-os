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

export interface SummarizationInput {
  text: string;
  requestedLength?: "SHORT" | "MEDIUM" | "LONG";
  style?: "BULLET" | "PARAGRAPH";
  language?: string;
  maxOutputTokens?: number;
}

export interface SummarizationOutput {
  summary: string;
  keyPoints: string[];
  language: string;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

const MANIFEST: SkillManifest = {
  key: "text-summarization",
  name: "Text Summarization",
  description:
    "Produces a concise, structured summary of a document or text block. Uses the employee's configured AI provider when available and falls back to deterministic extractive summarization otherwise.",
  category: "Text Processing",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 500_000 },
      requestedLength: { enum: ["SHORT", "MEDIUM", "LONG"] },
      style: { enum: ["BULLET", "PARAGRAPH"] },
      language: { type: "string", maxLength: 16 },
      maxOutputTokens: { type: "integer", minimum: 50, maximum: 2000 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["summary", "keyPoints", "language"],
    properties: {
      summary: { type: "string" },
      keyPoints: { type: "array", items: { type: "string" } },
      language: { type: "string" },
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
  capabilitySummary: ["Summarize documents", "Extract key points", "Translate to a requested style"]
};

@Injectable()
export class TextSummarizationSkill implements SkillAdapter<SummarizationInput, SummarizationOutput> {
  readonly manifest = MANIFEST;

  async validate(input: SummarizationInput): Promise<void> {
    if (!input.text?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "text is required");
    if (input.text.length > 500_000) throw new SkillError("SKILL_PAYLOAD_TOO_LARGE");
  }

  async execute(
    input: SummarizationInput,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult<SummarizationOutput>> {
    const language = input.language ?? "en";
    const maxTokens = input.maxOutputTokens ?? 600;

    if (context.capabilities.ai) {
      try {
        const result = await context.capabilities.ai.complete({
          messages: [
            {
              role: "system",
              content:
                "You summarize documents. Return JSON only with fields summary (string), keyPoints (array of strings)."
            },
            {
              role: "user",
              content: `Length: ${input.requestedLength ?? "MEDIUM"}; style: ${input.style ?? "PARAGRAPH"}; language: ${language}\n\nText:\n${input.text.slice(0, 120_000)}`
            }
          ],
          temperature: 0.2,
          maxOutputTokens: maxTokens
        });
        const parsed = parseSummary(result.content);
        return {
          data: {
            summary: parsed.summary,
            keyPoints: parsed.keyPoints,
            language,
            model: result.model,
            usage: {
              inputTokens: result.usage?.inputTokens ?? estimateTokens(input.text),
              outputTokens: result.usage?.outputTokens ?? estimateTokens(parsed.summary)
            }
          },
          usage: {
            inputTokens: result.usage?.inputTokens ?? estimateTokens(input.text),
            outputTokens: result.usage?.outputTokens ?? estimateTokens(parsed.summary),
            totalTokens:
              (result.usage?.inputTokens ?? estimateTokens(input.text)) +
              (result.usage?.outputTokens ?? estimateTokens(parsed.summary)),
            provider: result.provider,
            model: result.model
          }
        };
      } catch {
        // Fall through to deterministic summarization; a failing provider must never fail the turn.
      }
    }

    const { summary, keyPoints } = extractiveSummary(input.text, input.requestedLength ?? "MEDIUM");
    return {
      data: {
        summary,
        keyPoints,
        language,
        model: null,
        usage: {
          inputTokens: estimateTokens(input.text),
          outputTokens: estimateTokens(summary)
        }
      }
    };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([
      { name: "adapter-registered", status: "HEALTHY" },
      { name: "ai-provider", status: "HEALTHY", detail: "falls back to deterministic summarization" }
    ]);
  }
}

function parseSummary(content: string): { summary: string; keyPoints: string[] } {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown; keyPoints?: unknown };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : content,
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((item): item is string => typeof item === "string")
        : []
    };
  } catch {
    return { summary: content, keyPoints: [] };
  }
}

function extractiveSummary(text: string, length: "SHORT" | "MEDIUM" | "LONG"): { summary: string; keyPoints: string[] } {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length === 0) return { summary: "", keyPoints: [] };
  const target = length === "SHORT" ? 2 : length === "MEDIUM" ? 4 : 8;
  const selected = sentences.slice(0, Math.min(target, sentences.length));
  const keyPoints = sentences.slice(0, Math.min(3, sentences.length));
  return { summary: selected.join(" "), keyPoints };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
