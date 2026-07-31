import { describe, expect, it } from "vitest";
import { buildToolCatalog } from "./tool-catalog";
import type { ToolDefinition } from "./agent.runtime";

function def(name: string, description = "test tool"): ToolDefinition {
  return { name, version: "1.0.0", description, requiredPermissions: [], timeoutMs: 3000, inputSchema: { type: "object" } };
}

describe("buildToolCatalog", () => {
  it("maps every real registered tool to a friendly display name and category", () => {
    const catalog = buildToolCatalog([def("travel.resend_ticket"), def("travel.search_flights")]);
    const resend = catalog.find((entry) => entry.name === "travel.resend_ticket");
    expect(resend).toMatchObject({ displayName: "Resend Ticket", category: "Booking", kind: "AGENT_TOOL" });
    const search = catalog.find((entry) => entry.name === "travel.search_flights");
    expect(search).toMatchObject({ displayName: "Search Flights", category: "Search", kind: "AGENT_TOOL" });
  });

  it("still renders a tool it doesn't recognize (never silently drops it), using its own name/description", () => {
    const catalog = buildToolCatalog([def("connector.some_new_tool", "A brand new tool")]);
    expect(catalog).toContainEqual({
      name: "connector.some_new_tool",
      displayName: "connector.some_new_tool",
      description: "A brand new tool",
      category: "Platform",
      kind: "AGENT_TOOL"
    });
  });

  it("always includes the automatic capabilities (Email Sender, WhatsApp Sender, Booking Engine) even with an empty tool registry", () => {
    const catalog = buildToolCatalog([]);
    const names = catalog.map((entry) => entry.name);
    expect(names).toContain("platform.email_sender");
    expect(names).toContain("platform.whatsapp_sender");
    expect(names).toContain("platform.booking_engine");
    expect(catalog.every((entry) => entry.kind === "AUTOMATIC_CAPABILITY" || entry.kind === "AGENT_TOOL")).toBe(true);
  });
});
