import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CapabilityGrants, canManageCapability, runtimeReady } from "./capability-grants";

describe("Capability Grants", () => {
  it("renders every declared capability with grant status and actions", () => {
    const html = renderToStaticMarkup(
      <CapabilityGrants
        declared={["MEMORY", "EVENTS"]}
        granted={["EVENTS"]}
        isOwner
        isPlatformOwner={false}
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Capability Grants");
    expect(html).toContain("MEMORY");
    expect(html).toContain("EVENTS");
    expect(html).toContain("Not granted");
    expect(html).toContain("Granted");
    expect(html).toContain("Grant MEMORY");
    expect(html).toContain("Revoke EVENTS");
  });
  it("keeps mutation controls unavailable to unauthorized users", () => {
    const html = renderToStaticMarkup(
      <CapabilityGrants
        declared={["MEMORY"]}
        granted={[]}
        isOwner={false}
        isPlatformOwner={false}
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Only the organization Owner can change grants.");
    expect(html).not.toContain("Grant MEMORY");
  });
  it("locks the LLM grant to the platform owner even for the organization Owner", () => {
    const ownerHtml = renderToStaticMarkup(
      <CapabilityGrants
        declared={["LLM", "MEMORY"]}
        granted={[]}
        isOwner
        isPlatformOwner={false}
        onChange={vi.fn()}
      />
    );
    expect(ownerHtml).toContain("Grant MEMORY");
    expect(ownerHtml).not.toContain("Grant LLM");
    expect(ownerHtml).toContain("Only the platform owner can change this.");

    const platformOwnerHtml = renderToStaticMarkup(
      <CapabilityGrants
        declared={["LLM", "MEMORY"]}
        granted={[]}
        isOwner
        isPlatformOwner
        onChange={vi.fn()}
      />
    );
    expect(platformOwnerHtml).toContain("Grant LLM");
    expect(platformOwnerHtml).toContain("Grant MEMORY");
  });
  it("canManageCapability restricts LLM to the platform owner only", () => {
    expect(canManageCapability("LLM", true, false)).toBe(false);
    expect(canManageCapability("LLM", true, true)).toBe(true);
    expect(canManageCapability("LLM", false, false)).toBe(false);
    expect(canManageCapability("MEMORY", true, false)).toBe(true);
    expect(canManageCapability("MEMORY", false, false)).toBe(false);
  });
  it("marks only active MEMORY-enabled installations runtime ready", () => {
    expect(runtimeReady("ACTIVE", ["MEMORY"])).toBe(true);
    expect(runtimeReady("ACTIVE", [])).toBe(false);
    expect(runtimeReady("DISABLED", ["MEMORY"])).toBe(false);
  });
  it("deduplicates declared capabilities — duplicate CRM from permissions+capabilities renders once", () => {
    const html = renderToStaticMarkup(
      <CapabilityGrants
        declared={["CRM", "MEMORY", "CRM", "travel.search"]}
        granted={["CRM"]}
        isOwner
        isPlatformOwner={false}
        onChange={vi.fn()}
      />
    );
    // Each capability renders exactly once — no duplicate keys
    expect(html.match(/data-capability="CRM"/g)).toHaveLength(1);
    expect(html.match(/data-capability="MEMORY"/g)).toHaveLength(1);
    expect(html.match(/data-capability="travel.search"/g)).toHaveLength(1);
    expect(html).toContain("CRM");
    expect(html).toContain("MEMORY");
    expect(html).toContain("travel.search");
  });
});
