import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const LEGAL_EMPLOYEE_PLUGIN_ID = "legal-employee";

export const legalEmployeeManifest: PluginManifest = {
  id: LEGAL_EMPLOYEE_PLUGIN_ID,
  name: "Legal Document Employee",
  version: "1.0.0",
  displayName: "Legal Employee",
  description:
    "AI legal document employee. Reads incoming legal and regulatory notifications and drafts structured replies ready for professional review and filing.",
  author: "AI Workforce OS",
  entryPoint: "legal-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["legal.chat", "CRM"],
  tools: [
    {
      name: "legal.create_notice",
      description: "Persist a legal notice record after the client consents and shares a contact number"
    },
    { name: "legal.escalate", description: "Escalate the conversation to a licensed CA or advocate" }
  ]
};

export class LegalEmployeePlugin extends BasePlugin {
  readonly manifest = legalEmployeeManifest;

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
        message: "Legal Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default LegalEmployeePlugin;
