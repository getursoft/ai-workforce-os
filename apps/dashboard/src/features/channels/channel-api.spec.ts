import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createChannelApi } from "./channel-api";

describe("channel API", () => {
  it("creates, updates, and manages lifecycle actions for a channel", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createChannelApi({ request } as unknown as ApiClient);

    await api.create({
      name: "Travel WhatsApp",
      provider: "TWILIO",
      channelType: "WHATSAPP",
      agentId: "agent-1",
      configuration: { accountSid: "AC123", authToken: "secret", fromNumber: "+14155238886" }
    });
    expect(request).toHaveBeenLastCalledWith(
      "/channels",
      expect.objectContaining({ method: "POST" })
    );

    await api.update("channel-1", { name: "Renamed" });
    expect(request).toHaveBeenLastCalledWith("/channels/channel-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" })
    });

    await api.enable("channel-1");
    expect(request).toHaveBeenLastCalledWith("/channels/channel-1/enable", { method: "POST" });

    await api.disable("channel-1");
    expect(request).toHaveBeenLastCalledWith("/channels/channel-1/disable", { method: "POST" });

    await api.test("channel-1");
    expect(request).toHaveBeenLastCalledWith("/channels/channel-1/test", { method: "POST" });

    await api.remove("channel-1");
    expect(request).toHaveBeenLastCalledWith("/channels/channel-1", { method: "DELETE" });
  });

  it("sends the auth token only through the create/update payload, never as a separate read path", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createChannelApi({ request } as unknown as ApiClient);
    await api.update("channel-1", { configuration: { authToken: "fake-secret" } });
    expect(request).toHaveBeenCalledWith("/channels/channel-1", {
      method: "PATCH",
      body: JSON.stringify({ configuration: { authToken: "fake-secret" } })
    });
  });

  it("lists channels with search and pagination query parameters", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createChannelApi({ request } as unknown as ApiClient);
    await api.list({ pageSize: 50, search: "travel" });
    expect(request).toHaveBeenCalledWith("/channels?pageSize=50&search=travel");
  });

  it("fetches conversations and messages scoped to a channel", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createChannelApi({ request } as unknown as ApiClient);
    await api.conversations("channel-1", 2);
    expect(request).toHaveBeenCalledWith("/channels/channel-1/conversations?page=2&pageSize=20");
    await api.messages("channel-1", "conversation-1", 1);
    expect(request).toHaveBeenCalledWith(
      "/channels/channel-1/messages?page=1&pageSize=50&conversationId=conversation-1"
    );
  });
});
