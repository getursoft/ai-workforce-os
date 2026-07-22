import type { ConnectorContext } from "@ai-workforce-os/connector-sdk";
import { describe, expect, it, vi } from "vitest";
import { HubSpotConnector } from "./hubspot.connector";

const context: ConnectorContext = {
  organizationId: "organization-1",
  installationId: "installation-1",
  actorId: "user-1",
  requestId: "request-1",
  configuration: { timeoutMs: 1000 },
  credentials: { privateAppToken: "private-app-token-with-safe-test-length" },
  grantedCapabilities: new Set(["CRM"])
};
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("HubSpotConnector", () => {
  it("maps contacts and provider pagination without exposing raw responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        results: [{ id: "101", properties: { email: "traveler@example.com" } }],
        paging: { next: { after: "cursor-2" } }
      })
    );
    const connector = new HubSpotConnector(fetcher);
    const result = (await connector.executeTool(
      "crm.search_contacts",
      { query: "traveler", limit: 10 },
      context
    )) as { items: Array<{ id: string }>; nextAfter: string };
    expect(result).toEqual({
      items: [
        {
          id: "101",
          properties: { email: "traveler@example.com" },
          createdAt: null,
          updatedAt: null,
          archived: false
        }
      ],
      nextAfter: "cursor-2"
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.hubapi.com/crm/v3/objects/contacts/search"
    );
  });

  it("deduplicates contact creation by email", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json({ results: [{ id: "existing", properties: { email: "a@example.com" } }] })
      );
    const result = (await new HubSpotConnector(fetcher).executeTool(
      "crm.create_contact",
      { email: "a@example.com", firstname: "Ada" },
      context
    )) as { id: string; deduplicated: boolean };
    expect(result).toMatchObject({ id: "existing", deduplicated: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors rate limits with bounded retry and maps authentication failures safely", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "RATE_LIMIT" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(json({ status: "unauthorized" }, 401));
    const connector = new HubSpotConnector(fetcher, sleep, () => 0);
    await expect(
      connector.executeTool("crm.search_contacts", { query: "a" }, context)
    ).resolves.toMatchObject({ items: [] });
    expect(sleep).toHaveBeenCalledWith(1000);
    await expect(connector.testConnection(context)).rejects.toThrow(
      "CONNECTOR_AUTHENTICATION_FAILED"
    );
  });

  it("does not retry non-idempotent writes after an ambiguous provider failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      new HubSpotConnector(fetcher).executeTool(
        "crm.create_deal",
        { dealname: "Dubai trip" },
        context
      )
    ).rejects.toThrow("CONNECTOR_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
