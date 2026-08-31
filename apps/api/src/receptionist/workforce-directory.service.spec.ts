import { describe, expect, it, vi } from "vitest";
import { WorkforceDirectoryService } from "./workforce-directory.service";

function installed(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `${id}-employee`,
    displayName: `${id} Employee`,
    description: `${id} description`,
    status: "ACTIVE",
    lastHealthStatus: "READY",
    manifest: { capabilities: [`${id}.chat`] },
    grantedPermissions: [],
    employeeRoutingProfile: {
      employeeKey: `${id}-employee`,
      employeeType: "SPECIALIST",
      capabilities: [`${id}.work`],
      enabledForChannelRouting: true,
      enabledForDelegation: true,
      supportedIntents: [`${id.toUpperCase()}_REQUEST`],
      routingKeywords: [id],
      supportedDomains: [id],
      exampleQueries: [],
      excludedIntents: [],
      supportedTaskTypes: [`${id.toUpperCase()}_REQUEST`],
      channelEligibility: ["WEB", "WHATSAPP"],
      currentAvailability: "AVAILABLE",
      routingPriority: 100
    },
    skillGrants: [],
    ...overrides
  };
}

function subject(rows: unknown[]) {
  const findPlugins = vi.fn().mockResolvedValue(rows);
  const findConnectors = vi.fn().mockResolvedValue([]);
  return {
    findPlugins,
    findConnectors,
    directory: new WorkforceDirectoryService({
      plugin: { findMany: findPlugins },
      connectorInstallation: { findMany: findConnectors }
    } as never)
  };
}

describe("WorkforceDirectoryService", () => {
  it("queries plugins and connectors within one organization only", async () => {
    const { directory, findPlugins, findConnectors } = subject([installed("travel")]);
    await directory.list("tenant-a");
    expect(findPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "tenant-a", deletedAt: null } })
    );
    expect(findConnectors).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "tenant-a", status: "READY", deletedAt: null }
      })
    );
  });

  it("returns only safe routing metadata", async () => {
    const row = installed("travel", {
      manifest: { capabilities: ["travel.chat"], systemPrompt: "private" },
      encryptedSecrets: { token: "never expose" }
    });
    const { directory } = subject([row]);
    const [entry] = await directory.list("tenant-a");
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("private");
    expect(JSON.stringify(entry)).not.toContain("never expose");
    expect(Object.keys(entry ?? {})).not.toContain("manifest");
  });

  it("excludes receptionist, disabled, unhealthy, unavailable, and channel-ineligible employees", async () => {
    const disabled = installed("disabled", {
      employeeRoutingProfile: {
        ...installed("disabled").employeeRoutingProfile,
        enabledForChannelRouting: false
      }
    });
    const unhealthy = installed("unhealthy", { lastHealthStatus: "FAILED" });
    const unavailable = installed("busy", {
      employeeRoutingProfile: {
        ...installed("busy").employeeRoutingProfile,
        currentAvailability: "BUSY"
      }
    });
    const voiceOnly = installed("voice", {
      employeeRoutingProfile: {
        ...installed("voice").employeeRoutingProfile,
        channelEligibility: ["VOICE"]
      }
    });
    const { directory } = subject([
      installed("receptionist"),
      installed("travel"),
      disabled,
      unhealthy,
      unavailable,
      voiceOnly
    ]);
    const eligible = await directory.eligible("tenant-a", "WEB", "receptionist");
    expect(eligible.map((entry) => entry.pluginInstallationId)).toEqual(["travel"]);
  });

  it("does not invent an uninstalled employee", async () => {
    const { directory } = subject([installed("travel")]);
    const entries = await directory.eligible("tenant-a", "WEB", "receptionist");
    expect(entries).toHaveLength(1);
    expect(entries.some((entry) => entry.employeeKey === "finance-employee")).toBe(false);
  });
});
