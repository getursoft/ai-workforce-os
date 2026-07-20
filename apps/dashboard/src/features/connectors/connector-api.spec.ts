import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createConnectorApi } from "./connector-api";

describe("connector API", () => {
  it("uses the existing client for installation, capabilities, lifecycle and history", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createConnectorApi({ request } as unknown as ApiClient);
    await api.install({
      connectorKey: "dummy-crm",
      displayName: "CRM",
      configuration: {},
      credentials: {},
      grantedCapabilities: ["CRM"]
    });
    expect(request).toHaveBeenLastCalledWith(
      "/connector-installations",
      expect.objectContaining({ method: "POST" })
    );
    await api.updateCapabilities("installation-1", ["CRM"]);
    expect(request).toHaveBeenLastCalledWith(
      "/connector-installations/installation-1/capabilities",
      expect.objectContaining({ body: JSON.stringify({ grantedCapabilities: ["CRM"] }) })
    );
    await api.health("installation-1");
    expect(request).toHaveBeenLastCalledWith("/connector-installations/installation-1/health", {
      method: "POST"
    });
    await api.executions("installation-1");
    expect(request).toHaveBeenLastCalledWith(
      "/connector-installations/installation-1/executions?page=1&pageSize=20"
    );
  });
  it("sends credentials only to the write-only credential endpoint", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createConnectorApi({ request } as unknown as ApiClient);
    await api.updateCredentials("installation-1", { token: "fake-secret" });
    expect(request).toHaveBeenCalledWith("/connector-installations/installation-1/credentials", {
      method: "PATCH",
      body: JSON.stringify({ credentials: { token: "fake-secret" } })
    });
  });
});
