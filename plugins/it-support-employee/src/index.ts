import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const IT_SUPPORT_EMPLOYEE_PLUGIN_ID = "it-support-employee";

export const itSupportEmployeeManifest: PluginManifest = {
  id: IT_SUPPORT_EMPLOYEE_PLUGIN_ID,
  name: "IT Support Employee",
  version: "1.0.0",
  displayName: "IT Support Employee",
  description:
    "AI IT support employee. Handles first-line technical support, searches your knowledge base and triages incidents before escalating to your IT team.",
  author: "AI Workforce OS",
  entryPoint: "it-support-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["it.chat", "CRM"],
  tools: [
    {
      name: "it.create_ticket",
      description: "Persist an IT support request after the employee consents and shares a contact number"
    },
    { name: "it.escalate", description: "Escalate the conversation to a human IT support team member" }
  ]
};

export class ItSupportEmployeePlugin extends BasePlugin {
  readonly manifest = itSupportEmployeeManifest;

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
    return {
      success: false,
      tool: request.tool,
      durationMs: Date.now() - started,
      error: {
        code: "TOOL_NOT_FOUND",
        message: "IT Support Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default ItSupportEmployeePlugin;
