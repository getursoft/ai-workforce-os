import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createTravelApi } from "./travel-api";

describe("travel API", () => {
  it("reads and updates Travel Employee configuration", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createTravelApi({ request } as unknown as ApiClient);

    await api.configuration("plugin-1");
    expect(request).toHaveBeenLastCalledWith("/travel-employee/plugin-1/configuration");

    await api.updateConfiguration("plugin-1", { brandTone: "FORMAL", defaultCurrency: "INR" });
    expect(request).toHaveBeenLastCalledWith("/travel-employee/plugin-1/configuration", {
      method: "PATCH",
      body: JSON.stringify({ brandTone: "FORMAL", defaultCurrency: "INR" })
    });
  });

  it("reads conversation state and resets a conversation", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createTravelApi({ request } as unknown as ApiClient);

    await api.state("plugin-1", "conversation-1");
    expect(request).toHaveBeenLastCalledWith(
      "/travel-employee/plugin-1/conversations/conversation-1/state"
    );

    await api.resetConversation("plugin-1", "conversation-1");
    expect(request).toHaveBeenLastCalledWith(
      "/travel-employee/plugin-1/conversations/conversation-1/reset",
      { method: "POST" }
    );
  });
});
