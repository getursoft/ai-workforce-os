import { describe, expect, it } from "vitest";
import type { AvailablePlugin } from "./plugin-api";
import { canInstallPlugin, displayedHealth, isHealthPending } from "./plugin-page.logic";

const plugin = {
  id: "dummy",
  name: "Dummy",
  displayName: "Dummy",
  description: "",
  version: "1.0.0",
  author: "AI",
  permissions: [],
  capabilities: [],
  tools: [],
  installed: false
} satisfies AvailablePlugin;

describe("plugin page state", () => {
  it("deduplicates available and installed plugins by catalogue identity", () => {
    expect(canInstallPlugin(plugin)).toBe(true);
    expect(canInstallPlugin({ ...plugin, installed: true })).toBe(false);
  });
  it.each(["READY", "DEGRADED", "FAILED", "UNKNOWN"] as const)(
    "renders %s as a distinct health state",
    (status) => expect(displayedHealth(status)).toBe(status)
  );
  it("uses UNKNOWN before the first health result", () =>
    expect(displayedHealth(null)).toBe("UNKNOWN"));
  it("prevents a duplicate health request for the same installation", () => {
    expect(isHealthPending(true, "one", "one")).toBe(true);
    expect(isHealthPending(true, "other", "one")).toBe(false);
  });
});
