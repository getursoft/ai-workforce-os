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

/**
 * Caller-supplied description of what to extract, e.g.
 * { "invoiceNumber": "string", "totalAmount": "number", "dueDate": "string" }.
 * Field names and types are entirely caller-defined — this skill has no knowledge of any
 * specific employee's domain (Travel/HR/Legal/Finance). Domain-specific entity shapes belong to
 * the caller, not to this skill.
 */
export type EntitySchemaDeclaration = Record<string, "string" | "number" | "boolean" | "date">;

export interface EntityExtractionInput {
  text: string;
  entitySchema: EntitySchemaDeclaration;
  /** Optional free-text hint describing the document/domain, passed to the AI provider as context. */
  context?: string;
}

export interface EntityExtractionOutput {
  entities: Record<string, unknown>;
  confidence: number;
  warnings: string[];
}

const MAX_SCHEMA_FIELDS = 50;
const ENTITY_TYPES = new Set(["string", "number", "boolean", "date"]);

const MANIFEST: SkillManifest = {
  key: "entity-extraction",
  name: "Entity Extraction",
  description:
    "Extracts structured fields from free text according to a caller-supplied schema. The schema is fully caller-defined — this skill never hardcodes any employee's domain entities.",
  category: "Text Processing",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text", "entitySchema"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 200_000 },
      entitySchema: {
        type: "object",
        minProperties: 1,
        maxProperties: MAX_SCHEMA_FIELDS,
        additionalProperties: { enum: ["string", "number", "boolean", "date"] }
      },
      context: { type: "string", maxLength: 2000 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["entities", "confidence", "warnings"],
    properties: {
      entities: { type: "object" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      warnings: { type: "array", items: { type: "string" } }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: ["ai.provider.execute"],
  dependencies: [],
  billingCategory: "AI_PROVIDER_BACKED",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 1, backoffMs: 250 },
  statefulness: "STATELESS",
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      minConfidence: { type: "number", minimum: 0, maximum: 1 }
    }
  },
  capabilitySummary: ["Extract structured fields from text using a caller-defined schema"]
};

@Injectable()
export class EntityExtractionSkill implements SkillAdapter<EntityExtractionInput, EntityExtractionOutput> {
  readonly manifest = MANIFEST;

  async validate(input: EntityExtractionInput): Promise<void> {
    if (!input.text?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "text is required");
    const fields = Object.keys(input.entitySchema ?? {});
    if (fields.length === 0) throw new SkillError("SKILL_INPUT_INVALID", "entitySchema must declare at least one field");
    if (fields.length > MAX_SCHEMA_FIELDS)
      throw new SkillError("SKILL_INPUT_INVALID", `entitySchema may declare at most ${MAX_SCHEMA_FIELDS} fields`);
    for (const type of Object.values(input.entitySchema)) {
      if (!ENTITY_TYPES.has(type)) throw new SkillError("SKILL_INPUT_INVALID", `Unsupported entity type: ${type}`);
    }
  }

  async execute(
    input: EntityExtractionInput,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult<EntityExtractionOutput>> {
    const minConfidence = readNumber(context.configuration.minConfidence, 0);

    if (context.capabilities.ai) {
      try {
        const schemaDescription = Object.entries(input.entitySchema)
          .map(([field, type]) => `- ${field} (${type})`)
          .join("\n");
        const result = await context.capabilities.ai.complete({
          messages: [
            {
              role: "system",
              content:
                "You extract structured entities from text. Return JSON only: {\"entities\": {...}, \"confidence\": 0..1}. " +
                "Use null for fields you cannot find. Never invent values not present in the text."
            },
            {
              role: "user",
              content: `${input.context ? `Context: ${input.context}\n\n` : ""}Fields to extract:\n${schemaDescription}\n\nText:\n${input.text.slice(0, 100_000)}`
            }
          ],
          temperature: 0,
          maxOutputTokens: 800
        });
        const parsed = this.parseAndValidate(result.content, input.entitySchema);
        const warnings = parsed.confidence < minConfidence ? ["Extraction confidence below configured minimum"] : [];
        return {
          data: { entities: parsed.entities, confidence: parsed.confidence, warnings },
          usage: {
            inputTokens: result.usage?.inputTokens ?? estimateTokens(input.text),
            outputTokens: result.usage?.outputTokens ?? estimateTokens(result.content),
            totalTokens:
              (result.usage?.inputTokens ?? estimateTokens(input.text)) +
              (result.usage?.outputTokens ?? estimateTokens(result.content)),
            provider: result.provider,
            model: result.model
          }
        };
      } catch (error) {
        if (error instanceof SkillError) throw error;
        // Provider failure falls through to a deterministic best-effort pass rather than failing the turn.
      }
    }

    const { entities, warnings } = deterministicExtract(input.text, input.entitySchema);
    return { data: { entities, confidence: entities ? 0.4 : 0, warnings } };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([
      { name: "adapter-registered", status: "HEALTHY" },
      { name: "ai-provider", status: "HEALTHY", detail: "falls back to deterministic best-effort extraction" }
    ]);
  }

  private parseAndValidate(
    content: string,
    schema: EntitySchemaDeclaration
  ): { entities: Record<string, unknown>; confidence: number } {
    let parsed: { entities?: unknown; confidence?: unknown };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      return { entities: emptyEntities(schema), confidence: 0 };
    }
    const entities = emptyEntities(schema);
    if (parsed.entities && typeof parsed.entities === "object") {
      for (const field of Object.keys(schema)) {
        const value = (parsed.entities as Record<string, unknown>)[field];
        if (value !== undefined) entities[field] = value;
      }
    }
    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;
    return { entities, confidence };
  }
}

function emptyEntities(schema: EntitySchemaDeclaration): Record<string, unknown> {
  return Object.fromEntries(Object.keys(schema).map((field) => [field, null]));
}

/** Deterministic best-effort fallback used when no AI provider is configured. Only fills fields whose
 *  declared type has an unambiguous textual pattern (dates, numbers); string fields are left null rather
 *  than guessed, since guessing free text without an LLM is unreliable. */
function deterministicExtract(
  text: string,
  schema: EntitySchemaDeclaration
): { entities: Record<string, unknown>; warnings: string[] } {
  const entities = emptyEntities(schema);
  const warnings: string[] = ["No AI provider configured; only numeric/date fields were best-effort extracted"];
  const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/);
  // Search for a standalone number only in the text with any date substring removed first, so a
  // "quantity"-type field is never accidentally filled with a year/month/day fragment from a date.
  const textWithoutDate = dateMatch ? text.replace(dateMatch[0], " ") : text;
  const numberMatch = textWithoutDate.match(/-?\d+(\.\d+)?/);
  for (const [field, type] of Object.entries(schema)) {
    if (type === "number" && numberMatch) entities[field] = Number(numberMatch[0]);
    if (type === "date" && dateMatch) entities[field] = dateMatch[0];
  }
  return { entities, warnings };
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
