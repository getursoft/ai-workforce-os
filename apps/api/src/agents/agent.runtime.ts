import Ajv, { type ValidateFunction } from "ajv";
import { EMPLOYEE_SYSTEM_IDENTITY_PROMPT } from "../knowledge/knowledge.prompt";

export type ModelRole = "system" | "user" | "assistant" | "tool";
export interface ModelMessage {
  role: ModelRole;
  content: string;
  toolCallId?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
}
export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls";
  usage: { inputTokens: number; outputTokens: number };
}
export interface LlmProvider {
  readonly provider: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();
  register(provider: LlmProvider): void {
    if (this.providers.has(provider.provider)) throw new Error("MODEL_PROVIDER_COLLISION");
    this.providers.set(provider.provider, provider);
  }
  get(name: string): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error("MODEL_PROVIDER_UNAVAILABLE");
    return provider;
  }
}

/** Deterministic development provider. It performs no network access. */
export class DeterministicModelProvider implements LlmProvider {
  readonly provider = "deterministic";
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const last = request.messages.at(-1);
    const user = [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    if (last?.role !== "tool" && /remember.+prefer/i.test(user ?? "")) {
      const preference = /prefer\s+([^.,]+)/i.exec(user ?? "")?.[1]?.trim() ?? "vegetarian food";
      return {
        text: "",
        toolCalls: [
          {
            id: "memory-1",
            name: "platform.memory.save",
            input: { key: "preference.food", value: preference, scope: "USER" }
          }
        ],
        finishReason: "tool_calls",
        usage: usageFor(request, "memory")
      };
    }
    const response = /dubai/i.test(user ?? "")
      ? "Here is a five-day Dubai plan covering Old Dubai, Downtown, the desert, the marina, and a relaxed final day. I have remembered your food preference and will prioritize vegetarian options."
      : `Deterministic assistant response: ${user ?? "Request completed."}`;
    return {
      text: response,
      toolCalls: [],
      finishReason: "stop",
      usage: usageFor(request, response)
    };
  }
}

function usageFor(request: ModelRequest, output: string) {
  return {
    inputTokens: Math.max(
      1,
      Math.ceil(request.messages.map((x) => x.content).join(" ").length / 4)
    ),
    outputTokens: Math.max(1, Math.ceil(output.length / 4))
  };
}

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermissions: string[];
  timeoutMs: number;
  sensitiveInputPaths?: string[];
  sensitiveOutputPaths?: string[];
}
export interface ToolExecutionContext {
  organizationId: string;
  userId: string | null;
  pluginInstallationId: string;
  conversationId: string;
}

/** Identifies who triggered an agent execution: a dashboard user, or an external channel counterpart. */
export type AgentActor =
  | { type: "USER"; userId: string }
  | { type: "CHANNEL"; channelConnectionId: string; externalUserId: string };

/** Verified channel-contact identity, passed by the channel adapter when the sender identity is
 *  cryptographically or provider-verified (e.g. WhatsApp sender number from Meta webhook). The Agent
 *  Runtime and contact-capture workflows consume this to avoid redundant phone-number collection. */
export interface ChannelContact {
  channel: "WHATSAPP";
  provider: string;
  senderPhoneNumber: string;
  senderWhatsAppId?: string;
  verificationSource: "PROVIDER";
  verified: true;
  channelConnectionId: string;
  organizationId: string;
}

/** Provider-neutral execution request shared by dashboard chat and channel adapters (e.g. Twilio WhatsApp). */
export interface AgentExecutionInput {
  organizationId: string;
  agentId: string;
  conversationId?: string;
  actor: AgentActor;
  channelContact?: ChannelContact;
  text: string;
  source: { type: "DASHBOARD" } | { type: "CHANNEL"; channelId: string; externalUserId: string };
  requestId: string;
  metadata?: Record<string, unknown>;
}
export interface ToolHandler {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = createToolAjv();
  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.definition.name)) throw new Error("TOOL_REGISTRATION_COLLISION");
    this.validators.set(handler.definition.name, this.ajv.compile(handler.definition.inputSchema));
    this.handlers.set(handler.definition.name, handler);
  }
  definitions(names?: ReadonlySet<string>): ToolDefinition[] {
    return [...this.handlers.values()]
      .filter((handler) => !names || names.has(handler.definition.name))
      .map((handler) => handler.definition);
  }
  get(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error("TOOL_NOT_FOUND");
    return handler;
  }
  has(name: string): boolean {
    return this.handlers.has(name);
  }
  validate(name: string, input: unknown): asserts input is Record<string, unknown> {
    const validator = this.validators.get(name);
    if (!validator || !validator(input)) throw new Error("INVALID_TOOL_INPUT");
  }
}

function createToolAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat("email", {
    type: "string",
    validate: (value: string) => value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  });
  return ajv;
}

export class ToolPermissionPolicy {
  assertAllowed(
    handler: ToolHandler,
    available: ReadonlySet<string>,
    userPermissions: ReadonlySet<string>
  ): void {
    if (!available.has(handler.definition.name)) throw new Error("TOOL_NOT_PERMITTED");
    if (
      !handler.definition.requiredPermissions.every((permission) => userPermissions.has(permission))
    )
      throw new Error("TOOL_NOT_PERMITTED");
  }
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ToolPermissionPolicy
  ) {}
  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
    available: ReadonlySet<string>,
    permissions: ReadonlySet<string>
  ) {
    const handler = this.registry.get(name);
    this.policy.assertAllowed(handler, available, permissions);
    this.registry.validate(name, input);
    return withTimeout(
      handler.execute(input, context),
      handler.definition.timeoutMs,
      "TOOL_TIMEOUT"
    );
  }
}

/**
 * Assembles the final prompt in the order required by docs/enterprise-knowledge.md "Prompt
 * construction": System -> Employee Identity -> Retrieved Knowledge -> Conversation -> User.
 * Retrieved knowledge is placed before conversation history so it is never "buried" behind (and
 * therefore outweighed by) turns of prior chat when the model weighs recency.
 */
export class PromptBuilder {
  build(input: {
    organizationPrompt?: string;
    pluginPrompt: string;
    memories: string[];
    retrievedKnowledge?: string;
    history: ModelMessage[];
    message: string;
    tools: ToolDefinition[];
  }): ModelRequest {
    const messages: ModelMessage[] = [
      // System: base grounding rules and identity, shared by every AI Employee.
      { role: "system", content: EMPLOYEE_SYSTEM_IDENTITY_PROMPT },
      // Employee Identity: this specific employee's configured persona/org context.
      ...(input.organizationPrompt
        ? [{ role: "system" as const, content: limit(input.organizationPrompt) }]
        : []),
      { role: "system", content: limit(input.pluginPrompt) },
      {
        role: "system",
        content: "Use only the supplied tools. Never invent tool results or tenant identifiers."
      },
      // Retrieved Knowledge: must appear before conversation history, never after.
      ...(input.retrievedKnowledge
        ? [{ role: "system" as const, content: limit(input.retrievedKnowledge) }]
        : []),
      ...(input.memories.length
        ? [
            {
              role: "system" as const,
              content: `Relevant memories:\n${input.memories.map(limit).join("\n")}`
            }
          ]
        : []),
      // Conversation: prior turns.
      ...input.history.map((message) => ({ ...message, content: limit(message.content) })),
      // User: the current turn.
      { role: "user", content: limit(input.message) }
    ];
    return { model: "deterministic-v1", messages, tools: input.tools };
  }
}

export function redact(value: unknown, sensitivePaths: readonly string[] = []): unknown {
  if (!value || typeof value !== "object") return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const path of sensitivePaths) if (path in clone) clone[path] = "[REDACTED]";
  return clone;
}
export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>
): number | null {
  const price = pricing[`${provider}:${model}`];
  return price
    ? (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000
    : null;
}
export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function limit(value: string): string {
  return value.slice(0, 12_000);
}
