import { describe, expect, it, vi } from "vitest";
import { createEmployeeApi } from "./employee-api";
import type { ApiClient } from "../../lib/api-client";

describe("createEmployeeApi", () => {
  it("builds configuration GET/PATCH, state, reset, and artifact-list requests against the domain route", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createEmployeeApi(
      { request } as unknown as ApiClient,
      "/hr-employee",
      "tickets"
    );

    await api.configuration("plugin-1");
    expect(request).toHaveBeenLastCalledWith("/hr-employee/plugin-1/configuration");

    await api.updateConfiguration("plugin-1", { brandTone: "FORMAL" });
    expect(request).toHaveBeenLastCalledWith("/hr-employee/plugin-1/configuration", {
      method: "PATCH",
      body: JSON.stringify({ brandTone: "FORMAL" })
    });

    await api.state("plugin-1", "conversation-1");
    expect(request).toHaveBeenLastCalledWith(
      "/hr-employee/plugin-1/conversations/conversation-1/state"
    );

    await api.resetConversation("plugin-1", "conversation-1");
    expect(request).toHaveBeenLastCalledWith(
      "/hr-employee/plugin-1/conversations/conversation-1/reset",
      { method: "POST" }
    );

    await api.artifacts("plugin-1");
    expect(request).toHaveBeenLastCalledWith("/hr-employee/plugin-1/tickets");
  });

  it("supports a different domain route and artifact endpoint", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createEmployeeApi(
      { request } as unknown as ApiClient,
      "/sales-employee",
      "leads"
    );
    await api.artifacts("plugin-2");
    expect(request).toHaveBeenLastCalledWith("/sales-employee/plugin-2/leads");
  });
});
