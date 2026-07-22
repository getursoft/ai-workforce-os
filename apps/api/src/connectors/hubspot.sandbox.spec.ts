import type { ConnectorContext } from "@ai-workforce-os/connector-sdk";
import { describe, expect, it } from "vitest";
import { HubSpotConnector } from "./hubspot.connector";

const token = process.env.HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN;
const suite = token ? describe : describe.skip;

suite("HubSpot sandbox contract", () => {
  it("validates private-app credentials with a real safe read", async () => {
    const context: ConnectorContext = {
      organizationId: "sandbox",
      installationId: "sandbox",
      requestId: `sandbox-${Date.now()}`,
      configuration: { timeoutMs: 10000 },
      credentials: { privateAppToken: token ?? "" },
      grantedCapabilities: new Set(["CRM"])
    };
    await expect(new HubSpotConnector().testConnection(context)).resolves.toMatchObject({
      status: "READY"
    });
  });
});
