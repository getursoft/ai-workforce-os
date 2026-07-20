import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiToolCall,
  AiToolDefinition
} from "@ai-workforce-os/plugin-sdk";
import { withTimeout } from "../agents/agent.runtime";

export interface ProviderSettings {
  providerType: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
  model?: string;
  baseUrl?: string;
  endpoint?: string;
  deploymentName?: string;
  apiVersion?: string;
  timeoutMs: number;
}
type Fetcher = typeof fetch;
export type AiProviderErrorCode =
  | "AI_PROVIDER_AUTHENTICATION_FAILED"
  | "AI_PROVIDER_MODEL_NOT_FOUND"
  | "AI_PROVIDER_QUOTA_EXCEEDED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_TEST_FAILED"
  | "AI_PROVIDER_RESPONSE_INVALID";
export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    readonly upstreamStatus?: number,
    readonly stage: "provider_call" | "response_parse" = "provider_call"
  ) {
    super(code);
    this.name = "AiProviderError";
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    protected readonly settings: ProviderSettings,
    protected readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch
  ) {}
  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const model = required(this.settings.model, "AI_PROVIDER_CONFIGURATION_INVALID");
    const base = (this.settings.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    return this.call(`${base}/chat/completions`, model, request, {
      Authorization: `Bearer ${this.apiKey}`
    });
  }
  protected async call(
    url: string,
    model: string,
    request: AiCompletionRequest,
    headers: Record<string, string>
  ): Promise<AiCompletionResult> {
    let response: Response;
    try {
      response = await withTimeout(
        this.fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(mapRequest(request, model))
        }),
        this.settings.timeoutMs,
        "AI_PROVIDER_TIMEOUT"
      );
    } catch (error) {
      throw safeProviderError(error);
    }
    if (response.status === 401 || response.status === 403)
      throw new AiProviderError("AI_PROVIDER_AUTHENTICATION_FAILED", response.status);
    if (response.status === 404)
      throw new AiProviderError("AI_PROVIDER_MODEL_NOT_FOUND", response.status);
    if (response.status === 429)
      throw new AiProviderError("AI_PROVIDER_QUOTA_EXCEEDED", response.status);
    if (response.status >= 500)
      throw new AiProviderError("AI_PROVIDER_UNAVAILABLE", response.status);
    if (!response.ok) throw new AiProviderError("AI_PROVIDER_TEST_FAILED", response.status);
    const body = await safeJson(response);
    return mapResponse(
      body,
      this.settings.providerType === "AZURE_OPENAI" ? "azure-openai" : "openai-compatible",
      model,
      toolNameMap(request.tools ?? [])
    );
  }
}
export class AzureOpenAiProvider extends OpenAiCompatibleProvider {
  override async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const endpoint = required(this.settings.endpoint, "AI_PROVIDER_CONFIGURATION_INVALID").replace(
        /\/$/,
        ""
      ),
      deployment = required(this.settings.deploymentName, "AI_PROVIDER_CONFIGURATION_INVALID"),
      version = required(this.settings.apiVersion, "AI_PROVIDER_CONFIGURATION_INVALID");
    return this.call(
      `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`,
      deployment,
      request,
      { "api-key": this.apiKey }
    );
  }
}
export class DeterministicTravelProvider implements AiProvider {
  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const last = request.messages.at(-1),
      user = [...request.messages].reverse().find((x) => x.role === "user")?.content ?? "";
    if (
      last?.role !== "tool" &&
      /remember.+prefer/i.test(user) &&
      request.tools?.some((x) => x.name === "platform.memory.save")
    ) {
      const preference = /prefer\s+([^.,]+)/i.exec(user)?.[1]?.trim() ?? "vegetarian food";
      return {
        content: "",
        toolCalls: [
          {
            id: "memory-1",
            name: "platform.memory.save",
            arguments: { key: "preference.food", value: preference, scope: "USER" }
          }
        ],
        provider: "deterministic",
        model: "travel-test-v1",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
      };
    }
    if (
      last?.role !== "tool" &&
      /live|current price|availability/i.test(user) &&
      request.tools?.some((x) => x.name === "platform.http.request")
    )
      return {
        content: "",
        toolCalls: [
          {
            id: "http-1",
            name: "platform.http.request",
            arguments: { method: "GET", url: "https://travel.example.test/options" }
          }
        ],
        provider: "deterministic",
        model: "travel-test-v1",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
      };
    return {
      content: /dubai/i.test(user)
        ? "Here is a five-day Dubai plan covering Old Dubai, Downtown, the desert, the marina, and a relaxed final day. I have remembered your food preference and will prioritize vegetarian options."
        : "I can help draft a practical travel itinerary. No booking was performed, and any prices or availability should be verified with a live provider.",
      toolCalls: [],
      provider: "deterministic",
      model: "travel-test-v1",
      usage: { inputTokens: 30, outputTokens: 30, totalTokens: 60 }
    };
  }
}
export function createAiProvider(
  settings: ProviderSettings,
  apiKey: string | undefined,
  fetcher: Fetcher = fetch
): AiProvider {
  if (settings.providerType === "DETERMINISTIC") return new DeterministicTravelProvider();
  if (!apiKey) throw new AiProviderError("AI_PROVIDER_AUTHENTICATION_FAILED");
  if (settings.providerType === "AZURE_OPENAI")
    return new AzureOpenAiProvider(settings, apiKey, fetcher);
  if (settings.providerType === "OPENAI_COMPATIBLE")
    return new OpenAiCompatibleProvider(settings, apiKey, fetcher);
  throw new AiProviderError("AI_PROVIDER_TEST_FAILED");
}

function mapRequest(request: AiCompletionRequest, model: string) {
  const names = toolNameMap(request.tools ?? []);
  return {
    model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: names.get(message.name) ?? safeToolName(message.name) } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
    })),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: names.get(tool.name) ?? safeToolName(tool.name),
              description: tool.description,
              parameters: tool.inputSchema
            }
          }))
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {})
  };
}
function mapResponse(
  body: Record<string, unknown>,
  provider: string,
  model: string,
  names: ReadonlyMap<string, string>
): AiCompletionResult {
  const choices = Array.isArray(body.choices) ? body.choices : [],
    first = asRecord(choices[0]),
    message = asRecord(first.message),
    rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (
    choices.length === 0 ||
    Object.keys(message).length === 0 ||
    (typeof message.content !== "string" && rawCalls.length === 0)
  )
    throw new AiProviderError("AI_PROVIDER_RESPONSE_INVALID", undefined, "response_parse");
  const toolCalls: AiToolCall[] = rawCalls.map((raw) => {
    const call = asRecord(raw),
      fn = asRecord(call.function);
    let args: unknown = {};
    try {
      args = JSON.parse(String(fn.arguments ?? "{}"));
    } catch {
      throw new AiProviderError("AI_PROVIDER_RESPONSE_INVALID", undefined, "response_parse");
    }
    if (!isRecord(args))
      throw new AiProviderError("AI_PROVIDER_RESPONSE_INVALID", undefined, "response_parse");
    const externalName = String(fn.name ?? "");
    return {
      id: String(call.id ?? "tool-call"),
      name: names.get(externalName) ?? externalName,
      arguments: args
    };
  });
  const usage = asRecord(body.usage),
    inputTokens = numberOrUndefined(usage.prompt_tokens),
    outputTokens = numberOrUndefined(usage.completion_tokens),
    totalTokens = numberOrUndefined(usage.total_tokens);
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls,
    provider,
    model: typeof body.model === "string" ? body.model : model,
    ...(inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {})
          }
        }
      : {})
  };
}

function toolNameMap(tools: readonly AiToolDefinition[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const safe = safeToolName(tool.name);
    map.set(tool.name, safe);
    map.set(safe, tool.name);
  }
  return map;
}

function safeToolName(name: string): string {
  return name.replaceAll("_", "_u").replaceAll(".", "_d");
}

export interface HttpToolInput {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}
export class SafeHttpTool {
  readonly name = "platform.http.request";
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly resolver: (host: string) => Promise<string[]> = resolveHost
  ) {}
  async execute(
    input: HttpToolInput
  ): Promise<{ status: number; contentType: string; body: unknown }> {
    if (input.method !== "GET" && input.method !== "POST")
      throw new Error("HTTP_TOOL_INPUT_INVALID");
    const headers = safeHeaders(input.headers ?? {});
    let current = new URL(input.url),
      redirects = 0;
    while (true) {
      await this.assertDestination(current);
      const response = await withTimeout(
        this.fetcher(current, {
          method: input.method,
          redirect: "manual",
          headers: {
            ...headers,
            "user-agent": "AI-Workforce-OS-Tool/1.0",
            ...(input.method === "POST" ? { "content-type": "application/json" } : {})
          },
          ...(input.method === "POST" && input.body !== undefined
            ? { body: JSON.stringify(input.body) }
            : {})
        }),
        Math.min(input.timeoutMs ?? 10_000, 15_000),
        "HTTP_TOOL_TIMEOUT"
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (++redirects > 3) throw new Error("HTTP_REDIRECT_LIMIT");
        const location = response.headers.get("location");
        if (!location) throw new Error("HTTP_TOOL_FAILED");
        current = new URL(location, current);
        continue;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > 256_000) throw new Error("HTTP_RESPONSE_TOO_LARGE");
      const text = new TextDecoder().decode(buffer),
        contentType = response.headers.get("content-type") ?? "text/plain";
      let body: unknown = text;
      if (contentType.includes("json"))
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      return { status: response.status, contentType, body };
    }
  }
  private async assertDestination(url: URL) {
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("HTTP_DESTINATION_BLOCKED");
    if (hostname.endsWith(".local") || hostname === "localhost" || isIP(hostname))
      throw new Error("HTTP_DESTINATION_BLOCKED");
    const addresses = await this.resolver(hostname);
    if (!addresses.length || addresses.some(blockedAddress))
      throw new Error("HTTP_DESTINATION_BLOCKED");
  }
}
async function resolveHost(host: string) {
  return (await lookup(host, { all: true })).map((x) => x.address);
}
function blockedAddress(address: string) {
  if (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  )
    return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 ||
    address === "169.254.169.254"
  );
}
function safeHeaders(input: Record<string, string>) {
  const allowed = new Set(["accept", "content-type", "if-none-match"]),
    output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (!allowed.has(lower)) throw new Error("HTTP_HEADER_BLOCKED");
    output[lower] = value.slice(0, 1000);
  }
  return output;
}
function required(value: string | undefined, code: string) {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return asRecord(value);
  } catch {
    throw new Error("AI_PROVIDER_INVALID_RESPONSE");
  }
}
function safeProviderError(error: unknown) {
  if (error instanceof AiProviderError) return error;
  return new AiProviderError("AI_PROVIDER_UNAVAILABLE");
}
