import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const FINANCE_EMPLOYEE_PLUGIN_ID = "finance-employee";

export const financeEmployeeManifest: PluginManifest = {
  id: FINANCE_EMPLOYEE_PLUGIN_ID,
  name: "Finance Employee",
  version: "1.0.0",
  displayName: "Finance Employee",
  description:
    "AI finance employee. Helps with reports, invoices, expense classification and budget questions, with approvals kept in human hands.",
  author: "AI Workforce OS",
  entryPoint: "finance-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["finance.chat", "CRM"],
  tools: [
    {
      name: "finance.create_record",
      description: "Persist a finance request after the requester consents and shares a contact number"
    },
    { name: "finance.escalate", description: "Escalate the conversation to a human finance team member" }
  ]
};

export class FinanceEmployeePlugin extends BasePlugin {
  readonly manifest = financeEmployeeManifest;

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
        message: "Finance Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default FinanceEmployeePlugin;
