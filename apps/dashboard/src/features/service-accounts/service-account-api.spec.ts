import { describe, expect, it, vi } from "vitest";
import { createServiceAccountApi } from "./service-account-api";
describe("service account API", () => {
  it("covers CRUD and one-time key operations", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createServiceAccountApi({ request } as never);
    await api.list({ page: 2, status: "ACTIVE" });
    await api.create({ name: "Bot", roleIds: ["r"] });
    await api.createKey("s", { name: "Primary", environment: "LIVE" });
    await api.rotate("s", "k");
    await api.revoke("s", "k");
    await api.remove("s");
    expect(request).toHaveBeenCalledWith("/service-accounts?page=2&status=ACTIVE");
    expect(request).toHaveBeenCalledWith("/service-accounts/s/api-keys/k/rotate", {
      method: "POST"
    });
    expect(request).toHaveBeenCalledWith("/service-accounts/s", { method: "DELETE" });
  });
});
