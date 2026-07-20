import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginAiService } from "./plugin-ai.service";
import {
  DeterministicTravelProvider,
  OpenAiCompatibleProvider,
  SafeHttpTool
} from "./plugin-ai.runtime";
import { PluginSecretsEncryptionService } from "./plugin.runtime";

describe("PluginAiService persistence failures", () => {
  it("translates a missing Sprint 3.4 table into a stable safe error", async () => {
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-1",
          organizationId: "organization-1",
          deletedAt: null
        })
      },
      pluginAiConfiguration: {
        findUnique: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("table does not exist", {
            code: "P2021",
            clientVersion: "6.19.3"
          })
        )
      }
    } as unknown as PrismaService;
    const service = new PluginAiService(
      prisma,
      new PluginSecretsEncryptionService(Buffer.alloc(32, 7)),
      new SafeHttpTool()
    );

    await expect(
      service.update("organization-1", "user-1", "plugin-1", {
        providerType: "OPENAI_COMPATIBLE",
        model: "test-model",
        baseUrl: "https://api.example.test/v1",
        timeoutMs: 30000,
        secrets: { apiKey: "fake-test-key" }
      })
    ).rejects.toMatchObject({
      code: "DATABASE_SCHEMA_OUT_OF_DATE",
      message: "The database schema is not ready for plugin AI configuration."
    });
  });

  it("resolves the saved provider by the same installation id and reflects updates immediately", async () => {
    const encryption = new PluginSecretsEncryptionService(Buffer.alloc(32, 7));
    let stored: {
      pluginInstallationId: string;
      providerType: "OPENAI_COMPATIBLE" | "DETERMINISTIC";
      configuration: Record<string, unknown>;
      encryptedSecrets: ReturnType<PluginSecretsEncryptionService["encrypt"]>;
    } = {
      pluginInstallationId: "plugin-installation-1",
      providerType: "OPENAI_COMPATIBLE" as const,
      configuration: {
        model: "configured-model",
        baseUrl: "https://api.example.test/v1",
        timeoutMs: 30000
      },
      encryptedSecrets: encryption.encrypt({ apiKey: "fake-test-key" })
    };
    const findUnique = vi.fn(async () => stored);
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plugin-installation-1",
          organizationId: "organization-1",
          deletedAt: null
        })
      },
      pluginAiConfiguration: { findUnique }
    } as unknown as PrismaService;
    const service = new PluginAiService(prisma, encryption, new SafeHttpTool());

    const openAi = await service.resolveProvider("organization-1", "plugin-installation-1");
    expect(openAi.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(findUnique).toHaveBeenLastCalledWith({
      where: { pluginInstallationId: "plugin-installation-1" }
    });

    stored = {
      ...stored,
      providerType: "DETERMINISTIC",
      configuration: { timeoutMs: 30000 }
    };
    const deterministic = await service.resolveProvider(
      "organization-1",
      "plugin-installation-1"
    );
    expect(deterministic.provider).toBeInstanceOf(DeterministicTravelProvider);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
