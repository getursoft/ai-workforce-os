import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const MARKETING_EMPLOYEE_PLUGIN_ID = "marketing-employee";

export const marketingEmployeeManifest: PluginManifest = {
  id: MARKETING_EMPLOYEE_PLUGIN_ID,
  name: "Marketing Employee",
  version: "1.0.0",
  displayName: "Marketing Employee",
  description:
    "AI marketing employee. Supports campaign planning, drafts on-brand content and summarises performance so your marketing team can focus on strategy.",
  author: "AI Workforce OS",
  entryPoint: "marketing-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["marketing.chat", "CRM"],
  tools: [
    {
      name: "marketing.create_campaign",
      description: "Persist a campaign request after the requester consents and shares a contact number"
    },
    { name: "marketing.escalate", description: "Escalate the conversation to a human marketing team member" }
  ]
};

export class MarketingEmployeePlugin extends BasePlugin {
  readonly manifest = marketingEmployeeManifest;

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
        message: "Marketing Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default MarketingEmployeePlugin;
