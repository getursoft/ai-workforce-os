import { Logger } from "@nestjs/common";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider
} from "@ai-workforce-os/plugin-sdk";
import type { EmployeeDomainSpec } from "./employee-runtime";

/** API-flow configuration an employee uses when its "use real API" toggle is switched ON. */
export interface EmployeeApiConfig {
  enabled: boolean;
  endpoint: string | null;
  apiKey: string | null;
}

/**
 * A provider that forwards the conversation to a real backend API when the employee's "use real API"
 * toggle is ON. This is how an employee switches from the built-in dummy flow to a genuine integration
 * (e.g. a real booking engine, a real CRM, a real HR system): the admin turns the toggle on in the
 * employee's configuration and supplies the API base URL + key, and from then on every turn is sent to
 * that API as a chat request.
 *
 * The endpoint is called with a JSON body `{ messages, pluginInstallationId }` (OpenAI-compatible chat
 * request shape) plus an `Authorization: Bearer <apiKey>` header when a key is configured. The response
 * is expected to be `{ reply: string }` or an OpenAI-style `{ choices: [{ message: { content } }] }`.
 */
export class ApiBackedEmployeeProvider implements AiProvider {
  private readonly logger = new Logger(ApiBackedEmployeeProvider.name);
  private readonly spec: EmployeeDomainSpec;
  private readonly api: EmployeeApiConfig;

  constructor(spec: EmployeeDomainSpec, api: EmployeeApiConfig) {
    this.spec = spec;
    this.api = api;
  }

  get providerName(): string {
    return `${this.spec.slug}-api`;
  }

  get lastEntities(): Record<string, unknown> {
    return {};
  }

  get lastStage(): string {
    return "API";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.api.enabled || !this.api.endpoint) {
      return {
        content: "The real API integration is enabled but not configured with an endpoint.",
        toolCalls: [],
        provider: this.spec.providerName,
        model: `${this.spec.slug}-api-v1`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(this.api.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.api.apiKey ? { authorization: `Bearer ${this.api.apiKey}` } : {})
        },
        body: JSON.stringify({
          messages: request.messages,
          tools: request.tools ?? [],
          temperature: request.temperature ?? 0.3,
          max_output_tokens: request.maxOutputTokens ?? 700
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const content = extractReply(payload);
      if (!content) {
        throw new Error("API response did not contain a reply");
      }
      return {
        content,
        toolCalls: [],
        provider: `${this.spec.slug}-api`,
        model: `${this.spec.slug}-api-v1`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    } catch (error) {
      this.logger.warn({
        event: "EMPLOYEE_API_FLOW_FAILED",
        endpoint: this.api.endpoint,
        error: error instanceof Error ? error.message : "unknown"
      });
      return {
        content:
          "The real API integration could not be reached right now. Please check the API endpoint and key, or switch this employee back to the built-in flow.",
        toolCalls: [],
        provider: `${this.spec.slug}-api`,
        model: `${this.spec.slug}-api-v1`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Extracts a reply string from either `{ reply }` or an OpenAI-style `{ choices:[{message:{content}}] }`. */
function extractReply(payload: Record<string, unknown>): string | null {
  if (typeof payload.reply === "string") return payload.reply;
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.choices)) {
    const first = payload.choices[0] as { message?: { content?: unknown } } | undefined;
    if (typeof first?.message?.content === "string") return first.message.content;
  }
  if (typeof payload.response === "string") return payload.response;
  return null;
}
