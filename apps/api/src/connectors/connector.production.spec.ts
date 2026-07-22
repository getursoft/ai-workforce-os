import { describe, expect, it, vi } from "vitest";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import type { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { SafeHttpTool } from "../plugins/plugin-ai.runtime";
import {
  ConnectorManifestValidator,
  ConnectorRegistry,
  ConnectorSchemaValidator
} from "./connector.runtime";
import { ConnectorService } from "./connector.service";

describe("connector production isolation", () => {
  function productionService() {
    const registry = new ConnectorRegistry();
    const service = new ConnectorService(
      {} as PrismaService,
      new PluginSecretsEncryptionService(Buffer.alloc(32, 1)),
      new SafeHttpTool(vi.fn(), async () => ["203.0.113.1"]),
      new ConnectorManifestValidator(),
      new ConnectorSchemaValidator(),
      registry,
      { record: vi.fn() } as unknown as AuditEventLogger,
      { allowDevelopmentImplementations: false } as SecurityConfig
    );
    return { registry, service };
  }

  it("registers production connectors without registering Dummy CRM", () => {
    const { registry } = productionService();
    expect(
      registry
        .list()
        .map((connector) => connector.manifest.id)
        .sort()
    ).toEqual(["generic-http", "hubspot-crm"]);
  });

  it("rejects an explicit Dummy CRM installation before persistence", async () => {
    const { service } = productionService();
    await expect(
      service.install("organization-1", "user-1", "request-1", {
        connectorKey: "dummy-crm",
        displayName: "Forbidden dummy"
      })
    ).rejects.toMatchObject({ code: "DEVELOPMENT_CONNECTOR_NOT_ALLOWED" });
  });
});
