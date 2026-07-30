import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CapabilityGrants, runtimeReady } from "./capability-grants";

describe("Capability Grants", () => {
  it("renders every declared capability with grant status and actions", () => {
    const html = renderToStaticMarkup(
      <CapabilityGrants
        declared={["MEMORY", "EVENTS"]}
        granted={["EVENTS"]}
        canManage
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
      <CapabilityGrants declared={["MEMORY"]} granted={[]} canManage={false} onChange={vi.fn()} />
    );
    expect(html).toContain("Only Owners and Admins can change grants.");
    expect(html).not.toContain("Grant MEMORY");
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
        canManage
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
