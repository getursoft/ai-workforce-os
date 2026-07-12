import { ApiError } from "../../../lib/api-error";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationApi } from "./organization";

function clientReturning(value: unknown) {
  return { request: vi.fn().mockResolvedValue(value) };
}

describe("organization API", () => {
  it("loads and updates organization data with contract-safe paths", async () => {
    const organization = { id: "org-1", name: "Acme", slug: "acme", status: "ACTIVE" };
    const client = clientReturning({ organization });
    const api = createOrganizationApi(client as never);
    await expect(api.getOrganization()).resolves.toEqual(organization);
    expect(client.request).toHaveBeenCalledWith("/organizations/me", { method: "GET" });
    await api.updateOrganization({ name: "Acme Labs" });
    expect(client.request).toHaveBeenLastCalledWith("/organizations/me", {
      method: "PATCH",
      body: JSON.stringify({ name: "Acme Labs" })
    });
  });

  it("loads and updates only settings supported by the backend", async () => {
    const organizationSetting = {
      id: "set-1",
      organizationId: "org-1",
      timezone: "UTC",
      currency: "USD",
      locale: "en-US"
    };
    const client = clientReturning({ organizationSetting });
    const api = createOrganizationApi(client as never);
    await expect(api.getOrganizationSettings()).resolves.toEqual(organizationSetting);
    const command = { timezone: "Asia/Kolkata", currency: "INR", locale: "en-IN" };
    await api.updateOrganizationSettings(command);
    expect(client.request).toHaveBeenLastCalledWith("/organizations/me/settings", {
      method: "PATCH",
      body: JSON.stringify(command)
    });
  });

  it.each([
    [401, "authentication"],
    [403, "authorization"]
  ] as const)("propagates %s errors", async (status, kind) => {
    const error = new ApiError({ status, kind, code: "ERROR", message: "Denied" });
    const client = { request: vi.fn().mockRejectedValue(error) };
    const api = createOrganizationApi(client as never);
    await expect(api.getOrganization()).rejects.toBe(error);
  });
});
