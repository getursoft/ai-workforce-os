export type PluginHealthStatus = "READY" | "FAILED" | "DISABLED";

export interface PluginLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PluginContext {
  organizationId: string;
  userId: string;
  requestId: string;
  permissions: string[];
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
  permissions: string[];
  tools: PluginToolDefinition[];
  configSchema?: Record<string, unknown>;
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
}
