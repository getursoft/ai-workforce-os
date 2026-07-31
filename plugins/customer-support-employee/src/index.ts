import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_ID = "customer-support-employee";

export const customerSupportEmployeeManifest: PluginManifest = {
  id: CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_ID,
  name: "Customer Support Employee",
  version: "1.0.0",
  displayName: "Customer Support Employee",
  description:
    "AI customer support employee. Answers customer questions, troubleshoots common issues and keeps support tickets moving around the clock.",
  author: "AI Workforce OS",
  entryPoint: "customer-support-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["support.chat", "CRM"],
  tools: [
    {
      name: "support.create_ticket",
      description: "Persist a customer support request after the customer consents and shares a contact number"
    },
    { name: "support.escalate", description: "Escalate the conversation to a human support agent" }
  ]
};

export class CustomerSupportEmployeePlugin extends BasePlugin {
  readonly manifest = customerSupportEmployeeManifest;

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
        message: "Customer Support Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default CustomerSupportEmployeePlugin;
