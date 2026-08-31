import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { ReceptionistChannel } from "./receptionist.types";

export interface WorkforceDirectoryEntry {
  pluginInstallationId: string;
  employeeKey: string;
  employeeType: string | null;
  displayName: string;
  description: string;
  enabled: boolean;
  health: string;
  capabilities: string[];
  supportedIntents: string[];
  routingAliases: string[];
  domains: string[];
  examples: string[];
  negativeCapabilities: string[];
  supportedActions: string[];
  skillCapabilities: string[];
  connectorCapabilities: string[];
  channelEligibility: ReceptionistChannel[];
  delegationEligibility: boolean;
  currentAvailability: string;
  routingPriority: number;
}

/** Tenant-scoped, safe workforce discovery for intake/routing. No manifest prompts, configuration,
 * credentials, memories, document contents, or provider secrets are selected by this query. */
@Injectable()
export class WorkforceDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string): Promise<WorkforceDirectoryEntry[]> {
    const plugins = await this.prisma.plugin.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        displayName: true,
        description: true,
        status: true,
        lastHealthStatus: true,
        manifest: true,
        grantedPermissions: true,
        employeeRoutingProfile: true,
        skillGrants: {
          where: { organizationId, enabled: true },
          select: {
            skillInstallation: {
              select: {
                organizationId: true,
                enabled: true,
                deletedAt: true,
                skillVersion: { select: { requiredCapabilitiesJson: true } }
              }
            }
          }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    const connectors = await this.prisma.connectorInstallation.findMany({
      where: { organizationId, status: "READY", deletedAt: null },
      select: { grantedCapabilities: true }
    });
    const installedConnectorCapabilities = new Set(
      connectors.flatMap((row) => strings(row.grantedCapabilities))
    );

    return plugins.map((plugin) => {
      const profile = plugin.employeeRoutingProfile;
      const manifest = record(plugin.manifest);
      const manifestCapabilities = strings(manifest.capabilities);
      const profileCapabilities = strings(profile?.capabilities);
      const capabilities = unique([...manifestCapabilities, ...profileCapabilities]);
      const grants = new Set(strings(plugin.grantedPermissions));
      const connectorCapabilities = [...installedConnectorCapabilities].filter(
        (capability) => grants.has(capability) || capabilities.includes(capability)
      );
      const skillCapabilities = unique(
        plugin.skillGrants.flatMap((grant) => {
          const installation = grant.skillInstallation;
          if (
            installation.organizationId !== organizationId ||
            !installation.enabled ||
            installation.deletedAt
          )
            return [];
          return strings(installation.skillVersion.requiredCapabilitiesJson);
        })
      );
      const channelEligibility = strings(profile?.channelEligibility).filter(isChannel);
      return {
        pluginInstallationId: plugin.id,
        employeeKey: profile?.employeeKey ?? plugin.slug,
        employeeType: profile?.employeeType ?? null,
        displayName: plugin.displayName,
        description: plugin.description,
        enabled: plugin.status === "ACTIVE" && (profile?.enabledForChannelRouting ?? false),
        health: plugin.lastHealthStatus ?? "UNKNOWN",
        capabilities,
        supportedIntents: strings(profile?.supportedIntents),
        routingAliases: strings(profile?.routingKeywords),
        domains: strings(profile?.supportedDomains),
        examples: strings(profile?.exampleQueries),
        negativeCapabilities: strings(profile?.excludedIntents),
        supportedActions: strings(profile?.supportedTaskTypes),
        skillCapabilities,
        connectorCapabilities,
        channelEligibility: channelEligibility.length
          ? channelEligibility
          : (["WEB", "WHATSAPP", "VOICE"] as ReceptionistChannel[]),
        delegationEligibility: profile?.enabledForDelegation ?? false,
        currentAvailability: profile?.currentAvailability ?? "AVAILABLE",
        routingPriority: profile?.routingPriority ?? 0
      };
    });
  }

  async eligible(
    organizationId: string,
    channel: ReceptionistChannel,
    receptionistInstallationId: string
  ): Promise<WorkforceDirectoryEntry[]> {
    return (await this.list(organizationId)).filter(
      (employee) =>
        employee.pluginInstallationId !== receptionistInstallationId &&
        employee.enabled &&
        employee.delegationEligibility &&
        employee.channelEligibility.includes(channel) &&
        !["FAILED", "DISABLED"].includes(employee.health) &&
        employee.currentAvailability === "AVAILABLE"
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isChannel(value: string): value is ReceptionistChannel {
  return value === "WEB" || value === "WHATSAPP" || value === "VOICE";
}
