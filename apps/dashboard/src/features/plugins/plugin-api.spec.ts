import { describe, expect, it, vi } from "vitest";
import { createPluginApi } from "./plugin-api";
describe("plugin api", () => {
  it("uses scoped lifecycle endpoints and serializes secrets only in writes", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createPluginApi({ request } as never);
    await api.list({ page: 1, pageSize: 20, status: "ACTIVE" });
    await api.enable("p1");
    await api.health("p1");
    await api.updateGrants("p1", ["MEMORY"]);
    await api.install({
      pluginId: "dummy-echo",
      grantedPermissions: ["MEMORY"],
      configuration: { config: { prefix: "Hello" }, secrets: {} },
      enable: false
    });
    await api.updateConfiguration("p1", {
      config: { region: "IN" },
      secrets: { token: "replacement" }
    });
    expect(request).toHaveBeenCalledWith("/plugins?page=1&pageSize=20&status=ACTIVE");
    expect(request).toHaveBeenCalledWith("/plugins/p1/enable", { method: "POST" });
    expect(request).toHaveBeenCalledWith("/plugins/p1/health", { method: "POST" });
    expect(request).toHaveBeenCalledWith("/plugins/p1/grants", {
      method: "PATCH",
      body: JSON.stringify({ grantedPermissions: ["MEMORY"] })
    });
    expect(request).toHaveBeenCalledWith("/plugins/install", {
      method: "POST",
      body: JSON.stringify({
        pluginId: "dummy-echo",
        grantedPermissions: ["MEMORY"],
        configuration: { config: { prefix: "Hello" }, secrets: {} },
        enable: false
      })
    });
    expect(request).toHaveBeenLastCalledWith("/plugins/p1/configuration", {
      method: "PATCH",
      body: JSON.stringify({ config: { region: "IN" }, secrets: { token: "replacement" } })
    });
  });
  it("uses the existing plugin scope for AI configuration and chat", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createPluginApi({ request } as never);
    await api.aiConfiguration("p1");
    await api.updateAiConfiguration("p1", { providerType: "DETERMINISTIC" });
    await api.testAiConfiguration("p1");
    await api.chat("p1", { message: "Plan a trip", conversation: [] });
    expect(request).toHaveBeenCalledWith("/plugins/p1/ai-configuration");
    expect(request).toHaveBeenCalledWith("/plugins/p1/ai-configuration/test", { method: "POST" });
    expect(request).toHaveBeenLastCalledWith("/plugins/p1/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Plan a trip", conversation: [] })
    });
  });
});
