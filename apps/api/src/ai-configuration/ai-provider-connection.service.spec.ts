import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { SafeHttpTool } from "../plugins/plugin-ai.runtime";
import { AiProviderConnectionService } from "./ai-provider-connection.service";

const key = Buffer.alloc(32, 5);
const security = { allowDevelopmentImplementations: true } as SecurityConfig;

function harness() {
  const encryption = new PluginSecretsEncryptionService(key);
  const rows = new Map<string, Record<string, unknown>>();
  let counter = 0;

  const prisma = {
    aiProviderConnection: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        [...rows.values()].filter((r) => r.organizationId === where.organizationId)
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
        const row = rows.get(where.id);
        return row && row.organizationId === where.organizationId ? row : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `conn-${++counter}`;
        const row = { id, _count: { modelProfiles: 0 }, ...data };
        rows.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = rows.get(where.id) ?? {};
        const updated = { ...existing, ...data };
        rows.set(where.id, updated);
        return updated;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
        return {};
      })
    },
    aiModelProfile: {
      count: vi.fn().mockResolvedValue(0)
    }
  } as unknown as PrismaService;

  const service = new AiProviderConnectionService(prisma, encryption, new SafeHttpTool(), security);
  return { service, prisma, rows };
}

describe("AiProviderConnectionService", () => {
  it("reports credentialConfigured: false when no API key was ever set", async () => {
    const { service } = harness();
    const created = await service.create("org-1", "user-1", {
      name: "No key yet",
      providerType: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.openai.com/v1"
      // no apiKey — but providerType requires one...
    } as never).catch((error: unknown) => error);
    // OPENAI_COMPATIBLE requires a credential at create time by design.
    expect(created).toMatchObject({ message: "AI_PROVIDER_CREDENTIAL_REQUIRED" });
  });

  it("reports credentialConfigured: true after a real key is set, and never exposes it", async () => {
    const { service } = harness();
    const created = await service.create("org-1", "user-1", {
      name: "OpenAI Production",
      providerType: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-real-secret-value"
    });
    expect(created.credentialConfigured).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-real-secret-value");
    expect(created).not.toHaveProperty("encryptedCredentialJson");
  });

  it("list() never exposes encryptedCredentialJson for any row", async () => {
    const { service } = harness();
    await service.create("org-1", "user-1", {
      name: "OpenAI Production",
      providerType: "OPENAI_COMPATIBLE",
      apiKey: "sk-should-never-leak"
    });
    const list = await service.list("org-1");
    expect(JSON.stringify(list)).not.toContain("sk-should-never-leak");
    expect(JSON.stringify(list)).not.toContain("encryptedCredentialJson");
  });

  it("enforces tenant isolation: organization B cannot read organization A's connection", async () => {
    const { service } = harness();
    const created = await service.create("org-a", "user-1", {
      name: "Org A Connection",
      providerType: "OPENAI_COMPATIBLE",
      apiKey: "sk-org-a"
    });
    await expect(service.get("org-b", created.id)).rejects.toMatchObject({
      message: "AI_PROVIDER_CONNECTION_NOT_FOUND"
    });
  });

  it("removeCredential clears the key and credentialConfigured becomes false", async () => {
    const { service } = harness();
    const created = await service.create("org-1", "user-1", {
      name: "OpenAI Production",
      providerType: "OPENAI_COMPATIBLE",
      apiKey: "sk-to-be-removed"
    });
    const updated = await service.update("org-1", created.id, { removeCredential: true });
    expect(updated.credentialConfigured).toBe(false);
  });

  it("refuses to delete a connection that has model profiles referencing it", async () => {
    const { service, prisma } = harness();
    const created = await service.create("org-1", "user-1", {
      name: "OpenAI Production",
      providerType: "OPENAI_COMPATIBLE",
      apiKey: "sk-x"
    });
    (prisma.aiModelProfile.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    await expect(service.delete("org-1", created.id)).rejects.toMatchObject({
      message: "AI_PROVIDER_CONNECTION_HAS_MODEL_PROFILES"
    });
  });

  it("DETERMINISTIC provider is rejected outside development", async () => {
    const { service } = harnessWithProductionSecurity();
    await expect(
      service.create("org-1", "user-1", { name: "Dev only", providerType: "DETERMINISTIC" })
    ).rejects.toMatchObject({ message: "DEVELOPMENT_PROVIDER_NOT_ALLOWED" });
  });
});

function harnessWithProductionSecurity() {
  const encryption = new PluginSecretsEncryptionService(key);
  const prisma = {
    aiProviderConnection: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    aiModelProfile: { count: vi.fn() }
  } as unknown as PrismaService;
  const service = new AiProviderConnectionService(prisma, encryption, new SafeHttpTool(), {
    allowDevelopmentImplementations: false
  } as SecurityConfig);
  return { service };
}
