import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const HR_EMPLOYEE_PLUGIN_ID = "hr-employee";

export const hrEmployeeManifest: PluginManifest = {
  id: HR_EMPLOYEE_PLUGIN_ID,
  name: "HR Employee",
  version: "1.0.0",
  displayName: "HR Employee",
  description:
    "AI HR employee. Answers employee questions, guides onboarding and leave processes, and routes sensitive matters to your human HR team.",
  author: "AI Workforce OS",
  entryPoint: "hr-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["hr.chat", "CRM"],
  tools: [
    {
      name: "hr.create_ticket",
      description: "Persist an HR request after the employee consents and shares a contact number"
    },
    { name: "hr.escalate", description: "Escalate the conversation to a human HR team member" }
  ]
};

export class HrEmployeePlugin extends BasePlugin {
  readonly manifest = hrEmployeeManifest;

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
        message: "HR Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default HrEmployeePlugin;
