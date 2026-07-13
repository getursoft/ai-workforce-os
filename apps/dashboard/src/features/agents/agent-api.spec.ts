import { describe, expect, it, vi } from "vitest";
import { createAgentApi } from "./agent-api";
describe("agent api", () => {
  it("uses authenticated agent, conversation, and execution endpoints", async () => {
    const request = vi.fn().mockResolvedValue({}),
      api = createAgentApi({ request } as never);
    await api.employees();
    await api.run({ pluginInstallationId: "p", message: "hello" });
    await api.conversations();
    await api.messages("c");
    await api.executions();
    await api.execution("e");
    expect(request).toHaveBeenCalledWith("/agents/run", {
      method: "POST",
      body: JSON.stringify({ pluginInstallationId: "p", message: "hello" })
    });
    expect(request).toHaveBeenCalledWith("/conversations/c/messages");
    expect(request).toHaveBeenCalledWith("/executions/e");
  });
});
