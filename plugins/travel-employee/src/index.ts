import {
  BasePlugin,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest,
  PluginHealthStatus,
  PluginPermission
} from "@ai-workforce-os/plugin-sdk";

export const TRAVEL_EMPLOYEE_PLUGIN_ID = "travel-employee";

export const travelEmployeeManifest: PluginManifest = {
  id: TRAVEL_EMPLOYEE_PLUGIN_ID,
  name: "Travel Employee",
  version: "1.0.0",
  displayName: "Travel Employee",
  description:
    "AI travel planning employee. Collects destination, dates, passengers, and budget; searches placeholder flight and hotel options; recommends a plan; produces an itinerary summary; and escalates to a human when requested. Never claims a booking occurred and always labels prices and availability as unverified.",
  author: "AI Workforce OS",
  entryPoint: "travel-employee",
  permissions: [
    PluginPermission.LLM,
    PluginPermission.MEMORY,
    PluginPermission.TOOLS,
    PluginPermission.CRM
  ],
  capabilities: ["travel.chat", "CRM"],
  tools: [
    { name: "travel.search_flights", description: "Search placeholder flight options" },
    { name: "travel.search_hotels", description: "Search placeholder hotel options" },
    { name: "travel.escalate", description: "Escalate the conversation to a human team member" },
    {
      name: "travel.create_lead",
      description: "Persist a travel lead after the traveler consents and shares a contact number"
    }
  ]
};

export class TravelEmployeePlugin extends BasePlugin {
  readonly manifest = travelEmployeeManifest;

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
        message: "Travel Employee tools run through the Agent Runtime, not direct plugin execution."
      }
    };
  }
}

export default TravelEmployeePlugin;
