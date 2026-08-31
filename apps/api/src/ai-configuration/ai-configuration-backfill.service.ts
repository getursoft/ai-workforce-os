import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";

export interface BackfillResult {
  legacyConfigsScanned: number;
  connectionsCreated: number;
  connectionsReused: number;
  profilesCreated: number;
  profilesReused: number;
  assignmentsCreated: number;
  skipped: number;
  errors: number;
}

interface DecryptedLegacyRow {
  pluginInstallationId: string;
  organizationId: string;
  providerType: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
  configuration: Record<string, unknown>;
  apiKey: string | null;
  updatedBy: string;
}

/**
 * Idempotent, additive migration from per-employee PluginAiConfiguration rows to the shared
 * AiProviderConnection/AiModelProfile/EmployeeAiProfileAssignment model. Never deletes or mutates
 * PluginAiConfiguration — the legacy table remains fully intact and readable as a fallback for as
 * long as SHARED_AI_CONFIGURATION_ENABLED stays off (or for any org whose backfill hasn't run yet).
 *
 * Grouping rule: two legacy rows in the SAME organization become ONE AiProviderConnection only
 * when providerType, baseUrl/endpoint, AND the decrypted credential value are all identical — the
 * credential comparison happens entirely in memory and is never logged, persisted, or returned.
 * Different organizations are never grouped together, even with byte-identical credentials.
 *
 * Safe to re-run: an org/employee that already has a connection/profile/assignment from a prior
 * run is detected (by comparing decrypted values, not by a "backfill ran" flag) and reused/skipped
 * rather than duplicated.
 */
@Injectable()
export class AiConfigurationBackfillService {
  private readonly logger = new Logger(AiConfigurationBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService
  ) {}

  /** Runs for every organization that has at least one legacy PluginAiConfiguration row. Pass
   *  `organizationId` to scope a single-org dry run/rollout instead of the whole platform. */
  async run(organizationId?: string): Promise<BackfillResult> {
    const result: BackfillResult = {
      legacyConfigsScanned: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      profilesCreated: 0,
      profilesReused: 0,
      assignmentsCreated: 0,
      skipped: 0,
      errors: 0
    };
    const legacyRows = await this.prisma.pluginAiConfiguration.findMany({
      ...(organizationId ? { where: { organizationId } } : {}),
      orderBy: { createdAt: "asc" }
    });
    result.legacyConfigsScanned = legacyRows.length;

    const byOrganization = new Map<string, typeof legacyRows>();
    for (const row of legacyRows) {
      const bucket = byOrganization.get(row.organizationId) ?? [];
      bucket.push(row);
      byOrganization.set(row.organizationId, bucket);
    }

    for (const [orgId, rows] of byOrganization) {
      await this.runForOrganization(orgId, rows, result);
    }
    this.logger.log({
      event: "AI_CONFIGURATION_BACKFILL_COMPLETED",
      organizationsProcessed: byOrganization.size,
      ...result
    });
    return result;
  }

  private async runForOrganization(
    organizationId: string,
    legacyRows: Array<{
      id: string;
      pluginInstallationId: string;
      providerType: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
      configuration: unknown;
      encryptedSecrets: unknown;
      updatedBy: string;
    }>,
    result: BackfillResult
  ) {
    const decrypted: DecryptedLegacyRow[] = [];
    for (const row of legacyRows) {
      try {
        const secrets = this.decrypt(row.encryptedSecrets);
        decrypted.push({
          pluginInstallationId: row.pluginInstallationId,
          organizationId,
          providerType: row.providerType,
          configuration: (row.configuration ?? {}) as Record<string, unknown>,
          apiKey: secrets.apiKey ?? null,
          updatedBy: row.updatedBy
        });
      } catch (error) {
        result.errors++;
        this.logger.warn({
          event: "AI_CONFIGURATION_BACKFILL_DECRYPT_FAILED",
          organizationId,
          pluginInstallationId: row.pluginInstallationId,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }

    // Existing connections for this org — decrypted once up front so every group lookup below is
    // an in-memory comparison, not a repeated round-trip.
    const existingConnections = await this.prisma.aiProviderConnection.findMany({
      where: { organizationId }
    });
    const existingConnectionSecrets = new Map<string, string | null>();
    for (const connection of existingConnections) {
      try {
        const secrets = this.decrypt(connection.encryptedCredentialJson);
        existingConnectionSecrets.set(connection.id, secrets.apiKey ?? null);
      } catch {
        existingConnectionSecrets.set(connection.id, null);
      }
    }

    const groups = new Map<string, DecryptedLegacyRow[]>();
    for (const row of decrypted) {
      const key = identityKey(row.providerType, baseUrlOf(row.configuration), row.apiKey);
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    for (const [, rows] of groups) {
      const first = rows[0];
      if (!first) continue;
      const baseUrl = baseUrlOf(first.configuration);

      let connectionId = existingConnections.find(
        (candidate) =>
          candidate.providerType === first.providerType &&
          (candidate.baseUrl ?? null) === (baseUrl ?? null) &&
          existingConnectionSecrets.get(candidate.id) === first.apiKey
      )?.id;

      if (connectionId) {
        result.connectionsReused++;
      } else {
        try {
          const encrypted = this.encryption.encrypt(first.apiKey ? { apiKey: first.apiKey } : {});
          const created = await this.prisma.aiProviderConnection.create({
            data: {
              organizationId,
              name: `Migrated ${first.providerType} connection`,
              providerType: first.providerType,
              baseUrl: baseUrl ?? null,
              encryptedCredentialJson: encrypted as unknown as Prisma.InputJsonValue,
              metadataJson: legacyMetadataOf(first.configuration) as Prisma.InputJsonValue,
              createdByUserId: first.updatedBy
            }
          });
          connectionId = created.id;
          existingConnections.push(created);
          existingConnectionSecrets.set(created.id, first.apiKey);
          result.connectionsCreated++;
        } catch (error) {
          result.errors += rows.length;
          this.logger.warn({
            event: "AI_CONFIGURATION_BACKFILL_CONNECTION_FAILED",
            organizationId,
            providerType: first.providerType,
            error: error instanceof Error ? error.message : "unknown"
          });
          continue;
        }
      }

      const existingProfiles = await this.prisma.aiModelProfile.findMany({
        where: { organizationId, providerConnectionId: connectionId }
      });

      for (const row of rows) {
        try {
          const model = typeof row.configuration.model === "string" ? row.configuration.model : null;
          const embeddingModel =
            typeof row.configuration.embeddingModel === "string" ? row.configuration.embeddingModel : null;
          const timeoutMs = typeof row.configuration.timeoutMs === "number" ? row.configuration.timeoutMs : null;

          let profile = existingProfiles.find(
            (candidate) =>
              candidate.model === model &&
              candidate.embeddingModel === embeddingModel &&
              candidate.timeoutMs === timeoutMs
          );
          if (profile) {
            result.profilesReused++;
          } else {
            profile = await this.prisma.aiModelProfile.create({
              data: {
                organizationId,
                providerConnectionId: connectionId,
                name: profileNameFor(model, embeddingModel, existingProfiles.length),
                purpose: "DEFAULT",
                model,
                embeddingModel,
                timeoutMs,
                isDefault: existingProfiles.length === 0
              }
            });
            existingProfiles.push(profile);
            result.profilesCreated++;
          }

          const existingAssignment = await this.prisma.employeeAiProfileAssignment.findUnique({
            where: {
              organizationId_pluginInstallationId_purpose: {
                organizationId,
                pluginInstallationId: row.pluginInstallationId,
                purpose: "DEFAULT"
              }
            }
          });
          if (existingAssignment) {
            result.skipped++;
            continue;
          }
          await this.prisma.employeeAiProfileAssignment.create({
            data: {
              organizationId,
              pluginInstallationId: row.pluginInstallationId,
              modelProfileId: profile.id,
              purpose: "DEFAULT"
            }
          });
          result.assignmentsCreated++;
        } catch (error) {
          result.errors++;
          this.logger.warn({
            event: "AI_CONFIGURATION_BACKFILL_ASSIGNMENT_FAILED",
            organizationId,
            pluginInstallationId: row.pluginInstallationId,
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }
    }
  }

  private decrypt(payload: unknown): Record<string, string> {
    return this.encryption.decrypt(payload as EncryptedPayload);
  }
}

function baseUrlOf(configuration: Record<string, unknown>): string | null {
  const value = configuration.baseUrl ?? configuration.endpoint;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Azure's apiVersion is a connection-level setting in the new model (see AiConfigurationResolverService) —
 *  carried over here so a migrated Azure connection resolves identically to its legacy source. */
function legacyMetadataOf(configuration: Record<string, unknown>): Record<string, unknown> {
  return typeof configuration.apiVersion === "string" ? { apiVersion: configuration.apiVersion } : {};
}

function identityKey(providerType: string, baseUrl: string | null, apiKey: string | null): string {
  return `${providerType}|${baseUrl ?? ""}|${apiKey ?? ""}`;
}

function profileNameFor(model: string | null, embeddingModel: string | null, existingCount: number): string {
  const label = model ?? embeddingModel ?? "Default";
  return existingCount === 0 ? `Migrated ${label}` : `Migrated ${label} (${existingCount + 1})`;
}
