import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const dummyEchoManifest: PluginManifest = {
  id: "dummy-echo",
  name: "Dummy Echo",
  version: "1.0.0",
  displayName: "Dummy Echo Plugin",
  description: "Built-in plugin used to verify the plugin runtime",
  author: "AI Workforce OS",
  entryPoint: "dummy-echo",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.EVENTS,
    PluginPermission.CRM
  ],
  capabilities: ["dummy.echo", "travel.chat", "platform.http.request", "CRM"],
  tools: [{ name: "echo", description: "Returns the provided input" }],
  configSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        title: "Prefix",
        description: "Text prepended by the echo capability.",
        default: "Hello"
      }
    },
    additionalProperties: false
  }
};

export class DummyEchoPlugin extends BasePlugin {
  readonly manifest = dummyEchoManifest;

  async health(): Promise<PluginHealth> {
    return { status: PluginHealthStatus.READY, checkedAt: new Date().toISOString() };
  }

  override async install(): Promise<void> {}
  override async enable(): Promise<void> {}
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override async disable(): Promise<void> {}
  override async uninstall(): Promise<void> {}

  async execute(request: PluginExecutionRequest): Promise<PluginExecutionResult> {
    const started = Date.now();
    if (request.tool !== "echo") {
      return {
        success: false,
        tool: request.tool,
        durationMs: Date.now() - started,
        error: { code: "TOOL_NOT_FOUND", message: "The requested tool is not available." }
      };
    }
    return {
      success: true,
      tool: request.tool,
      durationMs: Date.now() - started,
      data: request.input
    };
  }
}
