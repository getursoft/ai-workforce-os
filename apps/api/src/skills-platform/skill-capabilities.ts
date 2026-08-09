import type { SkillCapabilities, SkillExecutionContext } from "@ai-workforce-os/skill-sdk";
import type { ObjectStorageService } from "../storage/object-storage.types";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import { SkillError } from "./skill-error";

export interface SkillCapabilityServices {
  objectStorage: ObjectStorageService;
  pluginAi: PluginAiService | null;
}

/**
 * Builds the least-privilege capability handle a skill receives. A capability is only present on the
 * handle when (a) the manifest requested it and (b) the runtime granted it. Skills never get raw
 * Prisma access or unrestricted tenant context; they operate on tenant state exclusively through
 * these handles, and every handle re-scopes by organization.
 */
export function buildSkillCapabilities(
  context: SkillExecutionContext,
  services: SkillCapabilityServices
): SkillCapabilities {
  const capabilities: SkillCapabilities = {};
  const granted = context.grantedCapabilities;

  if (granted.has("object.read")) {
    capabilities.object = {
      read: async (input) => {
        if (input.organizationId !== context.organizationId)
          throw new SkillError("SKILL_ORGANIZATION_DENIED");
        return services.objectStorage.getObject(input.organizationId, input.key);
      }
    };
  }

  if (granted.has("ai.provider.execute")) {
    capabilities.ai = {
      complete: async (input) => {
        if (!services.pluginAi) throw new SkillError("SKILL_ENTITLEMENT_DENIED", "AI provider unavailable");
        if (!context.pluginInstallationId)
          throw new SkillError("SKILL_ENTITLEMENT_DENIED", "AI capability requires an employee context");
        const { provider } = await services.pluginAi.resolveProvider(
          context.organizationId,
          context.pluginInstallationId
        );
        const result = await provider.complete({
          messages: input.messages,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {})
        });
        return {
          content: result.content,
          provider: result.provider,
          model: result.model,
          ...(result.usage
            ? {
                usage: {
                  ...(result.usage.inputTokens !== undefined
                    ? { inputTokens: result.usage.inputTokens }
                    : {}),
                  ...(result.usage.outputTokens !== undefined
                    ? { outputTokens: result.usage.outputTokens }
                    : {})
                }
              }
            : {})
        };
      }
    };
  }

  if (granted.has("knowledge.read")) {
    capabilities.knowledge = {
      read: async () => {
        throw new SkillError("SKILL_ENTITLEMENT_DENIED", "knowledge.read is not implemented in Sprint 6.1");
      }
    };
  }

  if (granted.has("network.external")) {
    capabilities.network = { available: false };
  }

  return capabilities;
}
