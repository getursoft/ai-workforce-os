import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const SALES_EMPLOYEE_PLUGIN_ID = "sales-employee";

export const salesEmployeeManifest: PluginManifest = {
  id: SALES_EMPLOYEE_PLUGIN_ID,
  name: "Sales Employee",
  version: "1.0.0",
  displayName: "Sales Employee",
  description:
    "AI sales employee. Qualifies leads, answers product questions, prepares reps for meetings and keeps CRM data current.",
  author: "AI Workforce OS",
  entryPoint: "sales-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["sales.chat", "CRM"],
  tools: [
    {
      name: "sales.create_lead",
      description: "Persist a sales lead after the prospect consents and shares a contact number"
    },
    { name: "sales.escalate", description: "Escalate the conversation to a human sales team member" }
  ]
};

export class SalesEmployeePlugin extends BasePlugin {
  readonly manifest = salesEmployeeManifest;

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
        message: "Sales Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default SalesEmployeePlugin;
