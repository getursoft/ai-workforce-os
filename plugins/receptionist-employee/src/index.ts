import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "../../../packages/plugin-sdk/dist/index.js";

export const RECEPTIONIST_EMPLOYEE_PLUGIN_ID = "receptionist-employee";

export const receptionistEmployeeManifest: PluginManifest = {
  id: RECEPTIONIST_EMPLOYEE_PLUGIN_ID,
  name: "AI Receptionist",
  version: "1.0.0",
  displayName: "AI Receptionist",
  description:
    "The configurable customer-facing front door for the installed AI workforce. It discovers and coordinates specialists without performing specialist domain work.",
  author: "AI Workforce OS",
  entryPoint: RECEPTIONIST_EMPLOYEE_PLUGIN_ID,
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.EVENTS,
    PluginPermission.TOOLS,
    PluginPermission.VOICE
  ],
  capabilities: [
    "workforce.intake",
    "workforce.route",
    "workforce.delegate",
    "workforce.status",
    "workforce.handoff",
    "customer.conversation",
    "customer.clarification"
  ],
  routing: {
    employeeKey: RECEPTIONIST_EMPLOYEE_PLUGIN_ID,
    employeeType: "RECEPTIONIST",
    domains: ["workforce intake", "customer conversation"],
    capabilities: ["workforce.intake", "workforce.route", "workforce.handoff"],
    intents: ["GREET", "DISCOVER_WORKFORCE", "CLARIFY_REQUIREMENT", "ROUTE_REQUEST"],
    examples: ["connect me to the right team", "what can you help me with"],
    aliases: ["receptionist", "front desk", "Krevia"],
    keywords: ["receptionist", "connect me", "right team"],
    supportedActions: ["WORKFORCE_INTAKE", "WORKFORCE_ROUTE", "WORKFORCE_HANDOFF"],
    channelEligibility: ["WEB", "WHATSAPP", "VOICE"],
    delegationEnabled: true,
    priority: 1000,
    enabled: true
  },
  tools: []
};

export class ReceptionistEmployeePlugin extends BasePlugin {
  readonly manifest = receptionistEmployeeManifest;

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
    return {
      success: false,
      tool: request.tool,
      durationMs: 0,
      error: {
        code: "TOOL_NOT_FOUND",
        message: "Receptionist intake and handoffs run through the platform workforce runtime."
      }
    };
  }
}

export default ReceptionistEmployeePlugin;
