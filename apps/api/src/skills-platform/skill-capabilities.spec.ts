import { describe, expect, it, vi } from "vitest";
import type { SkillExecutionContext } from "@ai-workforce-os/skill-sdk";
import { buildSkillCapabilities } from "./skill-capabilities";

function context(overrides: Partial<SkillExecutionContext> = {}): SkillExecutionContext {
  return {
    organizationId: "org-1",
    pluginInstallationId: "employee-1",
    grantedPermissions: new Set(),
    grantedCapabilities: new Set(["ai.provider.execute"]),
    configuration: {},
    idempotencyKey: "idem-1",
    capabilities: {},
    ...overrides
  } as SkillExecutionContext;
}

describe("buildSkillCapabilities ai.complete purpose forwarding", () => {
  it("forwards an explicit purpose (e.g. SUMMARIZATION) to PluginAiService.resolveProvider", async () => {
    const complete = vi.fn().mockResolvedValue({ content: "ok", provider: "test", model: "test-model" });
    const resolveProvider = vi.fn().mockResolvedValue({ provider: { complete } });
    const capabilities = buildSkillCapabilities(context(), {
      objectStorage: {} as never,
      pluginAi: { resolveProvider } as never
    });
    await capabilities.ai?.complete({ messages: [{ role: "user", content: "hi" }], purpose: "SUMMARIZATION" });
    expect(resolveProvider).toHaveBeenCalledWith("org-1", "employee-1", "SUMMARIZATION");
  });

  it("omits the purpose argument (falls back to DEFAULT) when no purpose is given", async () => {
    const complete = vi.fn().mockResolvedValue({ content: "ok", provider: "test", model: "test-model" });
    const resolveProvider = vi.fn().mockResolvedValue({ provider: { complete } });
    const capabilities = buildSkillCapabilities(context(), {
      objectStorage: {} as never,
      pluginAi: { resolveProvider } as never
    });
    await capabilities.ai?.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(resolveProvider).toHaveBeenCalledWith("org-1", "employee-1", undefined);
  });

  it("treats an explicit purpose of DEFAULT the same as omitting it", async () => {
    const complete = vi.fn().mockResolvedValue({ content: "ok", provider: "test", model: "test-model" });
    const resolveProvider = vi.fn().mockResolvedValue({ provider: { complete } });
    const capabilities = buildSkillCapabilities(context(), {
      objectStorage: {} as never,
      pluginAi: { resolveProvider } as never
    });
    await capabilities.ai?.complete({ messages: [{ role: "user", content: "hi" }], purpose: "DEFAULT" });
    expect(resolveProvider).toHaveBeenCalledWith("org-1", "employee-1", undefined);
  });
});
