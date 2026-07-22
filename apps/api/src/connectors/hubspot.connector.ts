import type {
  Connector,
  ConnectorContext,
  ConnectorManifest
} from "@ai-workforce-os/connector-sdk";

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number) => Promise<void>;

const objectId = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 100 } }
} as const;

export const hubSpotManifest: ConnectorManifest = {
  id: "hubspot-crm",
  name: "HubSpot CRM",
  description: "Production HubSpot CRM connector using a private-app bearer token.",
  category: "CRM",
  version: "1.0.0",
  authType: "BEARER_TOKEN",
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    properties: { timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 } }
  },
  credentialSchema: {
    type: "object",
    additionalProperties: false,
    required: ["privateAppToken"],
    properties: { privateAppToken: { type: "string", minLength: 20, maxLength: 500 } }
  },
  capabilities: ["CRM"],
  tools: [
    tool("crm.create_contact", "Create contact", "WRITE", {
      type: "object",
      additionalProperties: false,
      required: ["email"],
      properties: contactProperties()
    }),
    tool("crm.update_contact", "Update contact", "WRITE", {
      ...objectId,
      properties: { ...objectId.properties, ...contactProperties() }
    }),
    tool("crm.get_contact", "Get contact", "READ", objectId),
    tool("crm.search_contacts", "Search contacts", "READ", {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        email: { type: "string", format: "email", maxLength: 320 },
        after: { type: "string", maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      }
    }),
    tool("crm.create_note", "Create note", "WRITE", {
      type: "object",
      additionalProperties: false,
      required: ["body"],
      properties: {
        body: { type: "string", minLength: 1, maxLength: 10000 },
        contactId: { type: "string", maxLength: 100 }
      }
    }),
    tool("crm.create_deal", "Create deal", "WRITE", {
      type: "object",
      additionalProperties: false,
      required: ["dealname"],
      properties: dealProperties()
    }),
    tool("crm.update_deal", "Update deal", "WRITE", {
      ...objectId,
      properties: { ...objectId.properties, ...dealProperties() }
    }),
    tool("crm.associate_contact_with_deal", "Associate contact with deal", "WRITE", {
      type: "object",
      additionalProperties: false,
      required: ["contactId", "dealId"],
      properties: {
        contactId: { type: "string", minLength: 1, maxLength: 100 },
        dealId: { type: "string", minLength: 1, maxLength: 100 }
      }
    })
  ]
};

export class HubSpotConnector implements Connector {
  readonly manifest = hubSpotManifest;
  private readonly circuits = new Map<string, { failures: number; openUntil: number }>();

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly sleep: Sleeper = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random
  ) {}

  async testConnection(context: ConnectorContext) {
    await this.request(context, "GET", "/crm/v3/objects/contacts?limit=1", undefined, true);
    return { status: "READY" as const, checkedAt: new Date().toISOString() };
  }
  healthCheck = this.testConnection.bind(this);

  async executeTool(name: string, input: Record<string, unknown>, context: ConnectorContext) {
    switch (name) {
      case "crm.create_contact":
        return this.createContact(input, context);
      case "crm.update_contact":
        return this.objectWrite("contacts", input, context, "PATCH");
      case "crm.get_contact":
        return this.objectGet("contacts", String(input.id), context);
      case "crm.search_contacts":
        return this.searchContacts(input, context);
      case "crm.create_note":
        return this.createNote(input, context);
      case "crm.create_deal":
        return this.objectWrite("deals", input, context, "POST");
      case "crm.update_deal":
        return this.objectWrite("deals", input, context, "PATCH");
      case "crm.associate_contact_with_deal":
        return this.associate(input, context);
      default:
        throw new Error("CONNECTOR_TOOL_NOT_FOUND");
    }
  }

  private async createContact(input: Record<string, unknown>, context: ConnectorContext) {
    if (typeof input.email === "string") {
      const existing = await this.searchContacts({ email: input.email, limit: 1 }, context);
      if (existing.items.length) return { ...existing.items[0], deduplicated: true };
    }
    return this.objectWrite("contacts", input, context, "POST");
  }

  private async objectWrite(
    object: "contacts" | "deals",
    input: Record<string, unknown>,
    context: ConnectorContext,
    method: "POST" | "PATCH"
  ) {
    const id = typeof input.id === "string" ? input.id : undefined;
    const properties = Object.fromEntries(
      Object.entries(input).filter(([key, value]) => key !== "id" && value !== undefined)
    );
    const path = `/crm/v3/objects/${object}${id ? `/${encodeURIComponent(id)}` : ""}`;
    return mapObject(await this.request(context, method, path, { properties }, false));
  }

  private async objectGet(object: "contacts", id: string, context: ConnectorContext) {
    return mapObject(
      await this.request(
        context,
        "GET",
        `/crm/v3/objects/${object}/${encodeURIComponent(id)}`,
        undefined,
        true
      )
    );
  }

  private async searchContacts(input: Record<string, unknown>, context: ConnectorContext) {
    const limit = Math.min(Number(input.limit ?? 20), 100);
    const body: Record<string, unknown> = { limit };
    if (typeof input.after === "string") body.after = input.after;
    if (typeof input.query === "string") body.query = input.query;
    if (typeof input.email === "string")
      body.filterGroups = [
        { filters: [{ propertyName: "email", operator: "EQ", value: input.email }] }
      ];
    const result = await this.request(
      context,
      "POST",
      "/crm/v3/objects/contacts/search",
      body,
      true
    );
    const rows = Array.isArray(result.results) ? result.results : [];
    const paging = record(result.paging);
    const next = record(paging.next);
    return {
      items: rows.map((row) => mapObject(record(row))),
      nextAfter: typeof next.after === "string" ? next.after : null
    };
  }

  private async createNote(input: Record<string, unknown>, context: ConnectorContext) {
    const associations =
      typeof input.contactId === "string"
        ? [
            {
              to: { id: input.contactId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: 202
                }
              ]
            }
          ]
        : undefined;
    return mapObject(
      await this.request(
        context,
        "POST",
        "/crm/v3/objects/notes",
        {
          properties: {
            hs_note_body: input.body,
            hs_timestamp: new Date().toISOString()
          },
          ...(associations ? { associations } : {})
        },
        false
      )
    );
  }

  private async associate(input: Record<string, unknown>, context: ConnectorContext) {
    await this.request(
      context,
      "PUT",
      `/crm/v4/objects/contact/${encodeURIComponent(String(input.contactId))}/associations/deal/${encodeURIComponent(String(input.dealId))}`,
      [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 4 }],
      false
    );
    return { contactId: String(input.contactId), dealId: String(input.dealId), associated: true };
  }

  private async request(
    context: ConnectorContext,
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body: unknown,
    retryable: boolean
  ): Promise<Record<string, unknown>> {
    const token = context.credentials.privateAppToken;
    if (!token) throw new Error("CONNECTOR_CREDENTIALS_REQUIRED");
    const circuit = this.circuits.get(context.installationId);
    if (circuit?.openUntil && circuit.openUntil > Date.now())
      throw new Error("CONNECTOR_UNAVAILABLE");
    const timeoutMs = Math.min(Number(context.configuration.timeoutMs ?? 10000), 30000);
    const attempts = retryable ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(`https://api.hubapi.com${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "AI-Workforce-OS/1.0",
            "x-correlation-id": context.requestId
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal
        });
        if (response.ok) {
          this.circuits.delete(context.installationId);
          if (response.status === 204) return {};
          return await safeJson(response);
        }
        const code = statusCode(response.status);
        if (
          retryable &&
          (response.status === 429 || response.status >= 500) &&
          attempt + 1 < attempts
        ) {
          await this.sleep(retryDelay(response.headers.get("retry-after"), attempt, this.random));
          continue;
        }
        this.recordFailure(context.installationId);
        throw new Error(code);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("CONNECTOR_")) throw error;
        if (retryable && attempt + 1 < attempts) {
          await this.sleep(retryDelay(null, attempt, this.random));
          continue;
        }
        this.recordFailure(context.installationId);
        throw new Error(
          error instanceof Error && error.name === "AbortError"
            ? "CONNECTOR_TOOL_TIMEOUT"
            : "CONNECTOR_UNAVAILABLE"
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("CONNECTOR_UNAVAILABLE");
  }

  private recordFailure(installationId: string) {
    const failures = (this.circuits.get(installationId)?.failures ?? 0) + 1;
    this.circuits.set(installationId, {
      failures,
      openUntil: failures >= 3 ? Date.now() + 30_000 : 0
    });
  }
}

function tool(
  name: string,
  displayName: string,
  operationType: "READ" | "WRITE",
  inputSchema: Readonly<Record<string, unknown>>
) {
  return {
    name,
    displayName,
    description: `${displayName} in the configured HubSpot account.`,
    requiredCapability: "CRM",
    operationType,
    riskLevel: operationType === "READ" ? ("LOW" as const) : ("MEDIUM" as const),
    timeoutMs: 30000,
    inputSchema
  };
}

function contactProperties() {
  return {
    email: { type: "string", format: "email", maxLength: 320 },
    firstname: { type: "string", maxLength: 100 },
    lastname: { type: "string", maxLength: 100 },
    phone: { type: "string", maxLength: 50 },
    lifecyclestage: { type: "string", maxLength: 100 }
  };
}
function dealProperties() {
  return {
    dealname: { type: "string", minLength: 1, maxLength: 255 },
    amount: { oneOf: [{ type: "string" }, { type: "number" }] },
    dealstage: { type: "string", maxLength: 100 },
    pipeline: { type: "string", maxLength: 100 },
    closedate: { type: "string", maxLength: 100 }
  };
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function mapObject(value: Record<string, unknown>) {
  return {
    id: String(value.id ?? ""),
    properties: record(value.properties),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    archived: value.archived === true
  };
}
async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("CONNECTOR_RESPONSE_INVALID");
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("CONNECTOR_RESPONSE_INVALID");
  try {
    return record(JSON.parse(text));
  } catch {
    throw new Error("CONNECTOR_RESPONSE_INVALID");
  }
}
function statusCode(status: number) {
  if (status === 401 || status === 403) return "CONNECTOR_AUTHENTICATION_FAILED";
  if (status === 404) return "CONNECTOR_NOT_FOUND";
  if (status === 409) return "CONNECTOR_ALREADY_EXISTS";
  if (status === 422) return "CONNECTOR_CONFIGURATION_INVALID";
  if (status === 429) return "CONNECTOR_RATE_LIMITED";
  return status >= 500 ? "CONNECTOR_UNAVAILABLE" : "CONNECTOR_TOOL_EXECUTION_FAILED";
}
function retryDelay(retryAfter: string | null, attempt: number, random: () => number) {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(250 * 2 ** attempt + Math.floor(random() * 100), 5_000);
}
