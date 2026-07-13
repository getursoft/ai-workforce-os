import { describe, expect, it, vi } from "vitest";
import { createPluginApi } from "./plugin-api";
describe("plugin api", () => {
  it("uses scoped lifecycle endpoints and serializes secrets only in writes", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createPluginApi({ request } as never);
    await api.list({ page: 1, pageSize: 20, status: "ACTIVE" });
    await api.enable("p1");
    await api.health("p1");
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
});
