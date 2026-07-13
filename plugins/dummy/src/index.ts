import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest
} from "@ai-workforce-os/plugin-sdk";

export const dummyEchoManifest: PluginManifest = {
  id: "dummy-echo",
  name: "Dummy Echo",
  version: "1.0.0",
  displayName: "Dummy Echo Plugin",
  description: "Built-in plugin used to verify the plugin runtime",
  author: "AI Workforce OS",
  entryPoint: "dummy-echo",
  permissions: [],
  tools: [{ name: "echo", description: "Returns the provided input" }],
  configSchema: {
    type: "object",
    properties: { prefix: { type: "string" } },
    additionalProperties: false
  }
};

export class DummyEchoPlugin extends BasePlugin {
  readonly manifest = dummyEchoManifest;

  async health(): Promise<PluginHealth> {
    return { status: "READY", checkedAt: new Date().toISOString() };
  }

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
