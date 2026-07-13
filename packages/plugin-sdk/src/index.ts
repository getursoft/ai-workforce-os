export enum PluginHealthStatus {
  READY = "READY",
  DEGRADED = "DEGRADED",
  FAILED = "FAILED",
  UNKNOWN = "UNKNOWN",
  DISABLED = "DISABLED"
}
export enum PluginInstallationStatus {
  INSTALLED = "INSTALLED",
  ENABLED = "ENABLED",
  DISABLED = "DISABLED",
  FAILED = "FAILED"
}
export enum PluginPermission {
  LLM = "LLM",
  MEMORY = "MEMORY",
  EVENTS = "EVENTS",
  TOOLS = "TOOLS",
  EMAIL = "EMAIL",
  CALENDAR = "CALENDAR",
  CRM = "CRM",
  VOICE = "VOICE",
  SEARCH = "SEARCH",
  FILES = "FILES"
}
export type PluginCapability = string;
export type AiMessageRole = "system" | "user" | "assistant" | "tool";
export interface AiMessage {
  role: AiMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface AiCompletionRequest {
  messages: AiMessage[];
  tools?: AiToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}
export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface AiCompletionResult {
  content: string;
  toolCalls: AiToolCall[];
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
export interface AiProvider {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
export interface PluginConfiguration {
  readonly values: Readonly<Record<string, unknown>>;
  readonly configuredSecretKeys: readonly string[];
}
export interface PluginAction {
  name: string;
  description: string;
  execute(input: unknown, context: PluginContext): Promise<PluginResponse>;
}
export interface PluginMemory {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
export interface PluginEvent<T = unknown> {
  type: string;
  organizationId: string;
  payload: T;
  occurredAt: string;
}
export interface PluginService {
  readonly permission: PluginPermission;
}
export interface PluginServices {
  llm?: PluginService;
  memory?: PluginMemory;
  events?: PluginService;
  tools?: PluginService;
  files?: PluginService;
  email?: PluginService;
  calendar?: PluginService;
  crm?: PluginService;
  voice?: PluginService;
  search?: PluginService;
}

export interface PluginLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PluginContext {
  organizationId: string;
  actorUserId?: string;
  installationId: string;
  requestId: string;
  manifest: PluginManifest;
  config: Readonly<Record<string, unknown>>;
  permissions: ReadonlySet<PluginPermission>;
  services: PluginServices;
  logger: PluginLogger;
  metadata?: Record<string, unknown>;
}

export interface PluginToolDefinition {
  name: string;
  description: string;
}

export interface PluginResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface PluginTool extends PluginToolDefinition {
  execute(input: unknown, context: PluginContext): Promise<PluginResponse>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  entryPoint: string;
  permissions: PluginPermission[];
  capabilities?: PluginCapability[];
  tools: PluginToolDefinition[];
  configSchema?: Record<string, unknown>;
}

export interface PluginLifecycle {
  install?(context: PluginContext): Promise<void>;
  uninstall?(context: PluginContext): Promise<void>;
  enable?(context: PluginContext): Promise<void>;
  disable?(context: PluginContext): Promise<void>;
  start?(context: PluginContext): Promise<void>;
  stop?(context: PluginContext): Promise<void>;
  health?(context: PluginContext): Promise<PluginHealth>;
}
export interface PluginDefinition {
  manifest: PluginManifest;
  lifecycle: PluginLifecycle;
  tools?: readonly PluginTool[];
  actions?: readonly PluginAction[];
}
export interface PluginRuntime {
  install(definition: PluginDefinition, context: PluginContext): Promise<void>;
  enable(definition: PluginDefinition, context: PluginContext): Promise<void>;
  disable(definition: PluginDefinition, context: PluginContext): Promise<void>;
  uninstall(definition: PluginDefinition, context: PluginContext): Promise<void>;
  health(definition: PluginDefinition, context: PluginContext): Promise<PluginHealth>;
}

export interface PluginHealth {
  status: PluginHealthStatus;
  message?: string;
  checkedAt: string;
}

export interface PluginExecutionRequest {
  tool: string;
  input: unknown;
}

export interface PluginExecutionResult extends PluginResponse {
  tool: string;
  durationMs: number;
}

export abstract class BasePlugin {
  abstract readonly manifest: PluginManifest;
  abstract health(context?: PluginContext): Promise<PluginHealth>;
  abstract execute(
    request: PluginExecutionRequest,
    context: PluginContext
  ): Promise<PluginExecutionResult>;
  install?(context: PluginContext): Promise<void>;
  uninstall?(context: PluginContext): Promise<void>;
  enable?(context: PluginContext): Promise<void>;
  disable?(context: PluginContext): Promise<void>;
  start?(context: PluginContext): Promise<void>;
  stop?(context: PluginContext): Promise<void>;
}
