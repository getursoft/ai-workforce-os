import type {
  Connector,
  ConnectorContext,
  ConnectorManifest
} from "@ai-workforce-os/connector-sdk";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { SafeHttpTool } from "../plugins/plugin-ai.runtime";

const objectSchema = { type: "object", additionalProperties: false } as const;
export const dummyCrmManifest: ConnectorManifest = {
  id: "dummy-crm",
  name: "Dummy CRM",
  description: "Deterministic tenant-scoped CRM for connector and Travel AI demonstrations.",
  category: "CRM",
  version: "1.0.0",
  authType: "NONE",
  configurationSchema: objectSchema,
  credentialSchema: objectSchema,
  capabilities: ["CRM"],
  tools: [
    {
      name: "crm.create_lead",
      displayName: "Create lead",
      description:
        "Create a CRM lead from structured customer and travel requirements. Returns a lead reference.",
      requiredCapability: "CRM",
      operationType: "WRITE",
      riskLevel: "MEDIUM",
      timeoutMs: 5000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: {
          firstName: { type: "string", maxLength: 100 },
          lastName: { type: "string", maxLength: 100 },
          phone: { type: "string", maxLength: 40 },
          email: { type: "string", maxLength: 320 },
          source: { type: "string", maxLength: 100 },
          interest: { type: "string", maxLength: 255 },
          notes: { type: "string", maxLength: 4000 },
          metadata: { type: "object" }
        }
      }
    },
    ...["update_lead", "get_lead", "search_leads", "add_note"].map((name) => ({
      name: `crm.${name}`,
      displayName: name.replaceAll("_", " "),
      description: `${name.replaceAll("_", " ")} in the dummy CRM.`,
      requiredCapability: "CRM",
      operationType: (name.startsWith("get") || name.startsWith("search") ? "READ" : "WRITE") as
        "READ" | "WRITE",
      riskLevel: "LOW" as const,
      timeoutMs: 5000,
      inputSchema: { type: "object", additionalProperties: true }
    }))
  ]
};

export class DummyCrmConnector implements Connector {
  readonly manifest = dummyCrmManifest;
  constructor(private readonly prisma: PrismaClient) {}
  async testConnection(): Promise<{ status: "READY"; checkedAt: string }> {
    return { status: "READY", checkedAt: new Date().toISOString() };
  }
  healthCheck = this.testConnection;
  async executeTool(name: string, input: Record<string, unknown>, context: ConnectorContext) {
    if (name === "crm.create_lead") {
      const lead = await this.prisma.dummyCrmLead.create({
        data: {
          organizationId: context.organizationId,
          connectorInstallationId: context.installationId,
          firstName: text(input.firstName),
          lastName: text(input.lastName),
          phone: text(input.phone),
          email: text(input.email),
          source: text(input.source) ?? "AI_WORKFORCE_OS",
          interest: text(input.interest),
          notes: text(input.notes),
          metadata: (record(input.metadata) ?? {}) as Prisma.InputJsonValue
        }
      });
      return { leadId: lead.id, reference: `LEAD-${lead.id.slice(0, 8).toUpperCase()}` };
    }
    if (name === "crm.get_lead") {
      const leadId = text(input.leadId);
      return leadId
        ? this.prisma.dummyCrmLead.findFirst({
            where: { id: leadId, organizationId: context.organizationId }
          })
        : null;
    }
    if (name === "crm.update_lead") {
      const leadId = text(input.leadId);
      if (!leadId) throw new Error("CONNECTOR_CONFIGURATION_INVALID");
      const existing = await this.prisma.dummyCrmLead.findFirst({
        where: { id: leadId, organizationId: context.organizationId }
      });
      if (!existing) return null;
      return this.prisma.dummyCrmLead.update({
        where: { id: existing.id },
        data: {
          ...(text(input.firstName) ? { firstName: text(input.firstName) } : {}),
          ...(text(input.lastName) ? { lastName: text(input.lastName) } : {}),
          ...(text(input.phone) ? { phone: text(input.phone) } : {}),
          ...(text(input.email) ? { email: text(input.email) } : {}),
          ...(text(input.interest) ? { interest: text(input.interest) } : {}),
          ...(text(input.notes) ? { notes: text(input.notes) } : {}),
          ...(record(input.metadata)
            ? { metadata: record(input.metadata) as Prisma.InputJsonValue }
            : {})
        }
      });
    }
    if (name === "crm.add_note") {
      const leadId = text(input.leadId),
        note = text(input.note);
      if (!leadId || !note) throw new Error("CONNECTOR_CONFIGURATION_INVALID");
      const existing = await this.prisma.dummyCrmLead.findFirst({
        where: { id: leadId, organizationId: context.organizationId }
      });
      if (!existing) return null;
      return this.prisma.dummyCrmLead.update({
        where: { id: existing.id },
        data: { notes: [existing.notes, note].filter(Boolean).join("\n") }
      });
    }
    if (name === "crm.search_leads")
      return this.prisma.dummyCrmLead.findMany({
        where: { organizationId: context.organizationId },
        orderBy: { createdAt: "desc" },
        take: 20
      });
    return { success: true };
  }
}

export const genericHttpManifest: ConnectorManifest = {
  id: "generic-http",
  name: "Generic HTTP API",
  description: "Controlled API connector restricted to an administrator-approved base URL.",
  category: "API",
  version: "1.0.0",
  authType: "BEARER_TOKEN",
  capabilities: ["HTTP"],
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: {
      baseUrl: { type: "string", format: "uri" },
      allowedMethods: { type: "array", items: { enum: ["GET", "POST"] } },
      allowedPaths: { type: "array", items: { type: "string", pattern: "^/" } },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 }
    }
  },
  credentialSchema: {
    type: "object",
    additionalProperties: false,
    properties: { token: { type: "string", minLength: 1 } }
  },
  tools: [
    {
      name: "http.request",
      displayName: "HTTP request",
      description: "Call an approved path on the configured public API.",
      requiredCapability: "HTTP",
      operationType: "WRITE",
      riskLevel: "HIGH",
      timeoutMs: 30000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["method", "path"],
        properties: {
          method: { enum: ["GET", "POST"] },
          path: { type: "string", pattern: "^/" },
          body: {}
        }
      }
    }
  ]
};

export class GenericHttpConnector implements Connector {
  readonly manifest = genericHttpManifest;
  constructor(private readonly http: SafeHttpTool) {}
  async testConnection(context: ConnectorContext) {
    await this.call({ method: "GET", path: "/" }, context);
    return { status: "READY" as const, checkedAt: new Date().toISOString() };
  }
  healthCheck = this.testConnection.bind(this);
  executeTool(_name: string, input: Record<string, unknown>, context: ConnectorContext) {
    return this.call(input, context);
  }
  private call(input: Record<string, unknown>, context: ConnectorContext) {
    const base = new URL(String(context.configuration.baseUrl));
    const path = String(input.path ?? "/");
    const allowedPaths = Array.isArray(context.configuration.allowedPaths)
      ? context.configuration.allowedPaths.map(String)
      : ["/"];
    const method = input.method === "POST" ? "POST" : "GET";
    const allowedMethods = Array.isArray(context.configuration.allowedMethods)
      ? context.configuration.allowedMethods.map(String)
      : ["GET"];
    if (!allowedMethods.includes(method) || !allowedPaths.some((prefix) => path.startsWith(prefix)))
      throw new Error("CONNECTOR_CAPABILITY_NOT_GRANTED");
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("HTTP_DESTINATION_BLOCKED");
    return this.http.execute(
      {
        method,
        url: url.toString(),
        ...(input.body !== undefined ? { body: input.body } : {}),
        timeoutMs: Math.min(Number(context.configuration.timeoutMs ?? 10000), 30000)
      },
      context.credentials.token ? { Authorization: `Bearer ${context.credentials.token}` } : {}
    );
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
