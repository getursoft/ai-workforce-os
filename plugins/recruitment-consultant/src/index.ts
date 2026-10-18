import {
  BasePlugin,
  PluginHealthStatus,
  PluginPermission,
  type PluginContext,
  type PluginExecutionRequest,
  type PluginExecutionResult,
  type PluginHealth,
  type PluginManifest
} from "@ai-workforce-os/plugin-sdk";

export const RECRUITMENT_CONSULTANT_PLUGIN_ID = "recruitment-consultant";

export const recruitmentConsultantManifest: PluginManifest = {
  id: RECRUITMENT_CONSULTANT_PLUGIN_ID,
  name: "AI Recruitment Consultant",
  version: "1.0.0",
  displayName: "AI Recruitment Consultant",
  description:
    "Internal AI recruitment consultant. Manages job openings, parses and scores candidate resumes against approved job criteria, and surfaces recommendations for a recruiter's own review and decision.",
  author: "AI Workforce OS",
  entryPoint: "recruitment-consultant",
  permissions: [PluginPermission.LLM, PluginPermission.MEMORY],
  capabilities: ["recruitment.jobs", "recruitment.resumes", "recruitment.candidates"],
  tools: []
};

/** Internal-only employee — all real functionality lives in the dedicated `apps/api/src/recruitment`
 *  module's REST API (job CRUD, resume upload/parsing, scoring, review), not in a conversational
 *  `execute()` loop like the customer-facing employees. This class exists only so the Recruitment
 *  Consultant is a real, installable row in the plugin system (Phase 1's "registered in the existing
 *  AI employee/plugin system") — it is never routed to by the AI Receptionist (plugin.json's
 *  `routing.delegationEnabled: false`) and has no chat capability of its own. */
export class RecruitmentConsultantPlugin extends BasePlugin {
  readonly manifest = recruitmentConsultantManifest;

  async health(_context?: PluginContext): Promise<PluginHealth> {
    return { status: PluginHealthStatus.READY, checkedAt: new Date().toISOString() };
  }

  async execute(
    request: PluginExecutionRequest,
    _context: PluginContext
  ): Promise<PluginExecutionResult> {
    return {
      success: false,
      tool: request.tool,
      durationMs: 0,
      error: {
        code: "NOT_SUPPORTED",
        message: "The AI Recruitment Consultant has no chat/tool execution — use the /recruitment REST API."
      }
    };
  }
}

export default RecruitmentConsultantPlugin;
