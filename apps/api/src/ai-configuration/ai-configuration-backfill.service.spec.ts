import { describe, expect, it } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { AiConfigurationBackfillService } from "./ai-configuration-backfill.service";

const key = Buffer.alloc(32, 3);

interface LegacyRowSeed {
  id: string;
  pluginInstallationId: string;
  organizationId: string;
  providerType: "OPENAI_COMPATIBLE" | "AZURE_OPENAI" | "DETERMINISTIC";
  configuration: Record<string, unknown>;
  apiKey: string;
  updatedBy: string;
}

function fakePrisma(encryption: PluginSecretsEncryptionService, legacyRowSeeds: LegacyRowSeed[]) {
  const legacyRows = legacyRowSeeds.map((seed) => ({
    id: seed.id,
    pluginInstallationId: seed.pluginInstallationId,
    organizationId: seed.organizationId,
    providerType: seed.providerType,
    configuration: seed.configuration,
    encryptedSecrets: encryption.encrypt({ apiKey: seed.apiKey }),
    updatedBy: seed.updatedBy,
    createdAt: new Date()
  }));
  const connections: Array<Record<string, unknown>> = [];
  const profiles: Array<Record<string, unknown>> = [];
  const assignments: Array<Record<string, unknown>> = [];
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const prisma = {
    pluginAiConfiguration: {
      findMany: async ({ where }: { where?: { organizationId: string } }) =>
        where ? legacyRows.filter((row) => row.organizationId === where.organizationId) : legacyRows
    },
    aiProviderConnection: {
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        connections.filter((c) => c.organizationId === where.organizationId),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("conn"), ...data };
        connections.push(row);
        return row;
      }
    },
    aiModelProfile: {
      findMany: async ({ where }: { where: { organizationId: string; providerConnectionId: string } }) =>
        profiles.filter(
          (p) => p.organizationId === where.organizationId && p.providerConnectionId === where.providerConnectionId
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("profile"), ...data };
        profiles.push(row);
        return row;
      }
    },
    employeeAiProfileAssignment: {
      findUnique: async ({
        where
      }: {
        where: { organizationId_pluginInstallationId_purpose: { organizationId: string; pluginInstallationId: string; purpose: string } };
      }) => {
        const w = where.organizationId_pluginInstallationId_purpose;
        return (
          assignments.find(
            (a) =>
              a.organizationId === w.organizationId &&
              a.pluginInstallationId === w.pluginInstallationId &&
              a.purpose === w.purpose
          ) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("assignment"), ...data };
        assignments.push(row);
        return row;
      }
    }
  } as unknown as PrismaService;

  return { prisma, connections, profiles, assignments };
}

describe("AiConfigurationBackfillService", () => {
  it("deduplicates two employees in the SAME organization sharing an identical credential into ONE connection", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { prisma, connections, profiles, assignments } = fakePrisma(encryption, [
      {
        id: "cfg-1",
        pluginInstallationId: "travel-1",
        organizationId: "org-1",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-shared-secret",
        updatedBy: "user-1"
      },
      {
        id: "cfg-2",
        pluginInstallationId: "hr-1",
        organizationId: "org-1",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-shared-secret",
        updatedBy: "user-1"
      }
    ]);
    const service = new AiConfigurationBackfillService(prisma, encryption);

    const result = await service.run("org-1");

    expect(result.legacyConfigsScanned).toBe(2);
    expect(result.connectionsCreated).toBe(1);
    expect(connections).toHaveLength(1);
    expect(result.profilesCreated).toBe(1);
    expect(profiles).toHaveLength(1);
    expect(result.assignmentsCreated).toBe(2);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.pluginInstallationId).sort()).toEqual(["hr-1", "travel-1"]);
    // No plaintext credential anywhere in what gets stored.
    expect(JSON.stringify(connections)).not.toContain("sk-shared-secret");
  });

  it("keeps two employees with DIFFERENT credentials in the same org as separate connections", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { prisma, connections } = fakePrisma(encryption, [
      {
        id: "cfg-1",
        pluginInstallationId: "travel-1",
        organizationId: "org-1",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-key-a",
        updatedBy: "user-1"
      },
      {
        id: "cfg-2",
        pluginInstallationId: "legal-1",
        organizationId: "org-1",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-key-b",
        updatedBy: "user-1"
      }
    ]);
    const service = new AiConfigurationBackfillService(prisma, encryption);

    const result = await service.run("org-1");

    expect(result.connectionsCreated).toBe(2);
    expect(connections).toHaveLength(2);
  });

  it("NEVER groups identical credentials across different organizations", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { prisma, connections } = fakePrisma(encryption, [
      {
        id: "cfg-1",
        pluginInstallationId: "travel-1",
        organizationId: "org-a",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-byte-identical",
        updatedBy: "user-1"
      },
      {
        id: "cfg-2",
        pluginInstallationId: "travel-2",
        organizationId: "org-b",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-byte-identical",
        updatedBy: "user-2"
      }
    ]);
    const service = new AiConfigurationBackfillService(prisma, encryption);

    const result = await service.run();

    expect(result.connectionsCreated).toBe(2);
    expect(connections.map((c) => c.organizationId).sort()).toEqual(["org-a", "org-b"]);
  });

  it("is idempotent: running twice does not duplicate connections, profiles, or assignments", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { prisma, connections, profiles, assignments } = fakePrisma(encryption, [
      {
        id: "cfg-1",
        pluginInstallationId: "travel-1",
        organizationId: "org-1",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", timeoutMs: 30000 },
        apiKey: "sk-idempotent",
        updatedBy: "user-1"
      }
    ]);
    const service = new AiConfigurationBackfillService(prisma, encryption);

    const first = await service.run("org-1");
    const second = await service.run("org-1");

    expect(first.connectionsCreated).toBe(1);
    expect(second.connectionsCreated).toBe(0);
    expect(second.connectionsReused).toBe(1);
    expect(second.profilesReused).toBe(1);
    expect(second.skipped).toBe(1); // assignment already exists from the first run
    expect(connections).toHaveLength(1);
    expect(profiles).toHaveLength(1);
    expect(assignments).toHaveLength(1);
  });

  it("scans across all organizations when no organizationId filter is given", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { prisma } = fakePrisma(encryption, [
      {
        id: "cfg-1",
        pluginInstallationId: "travel-1",
        organizationId: "org-a",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", timeoutMs: 30000 },
        apiKey: "sk-a",
        updatedBy: "user-1"
      },
      {
        id: "cfg-2",
        pluginInstallationId: "travel-2",
        organizationId: "org-b",
        providerType: "OPENAI_COMPATIBLE",
        configuration: { model: "gpt-4.1", timeoutMs: 30000 },
        apiKey: "sk-b",
        updatedBy: "user-2"
      }
    ]);
    const service = new AiConfigurationBackfillService(prisma, encryption);
    const result = await service.run();
    expect(result.legacyConfigsScanned).toBe(2);
    expect(result.connectionsCreated).toBe(2);
  });
});
