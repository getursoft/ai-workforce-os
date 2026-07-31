import type { ToolDefinition } from "./agent.runtime";

export type ToolCatalogCategory = "Communication" | "Booking" | "CRM" | "Search" | "Memory" | "Escalation" | "Platform";

export interface ToolCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  category: ToolCatalogCategory;
  /** AGENT_TOOL: directly callable by an AI employee through the tool-calling loop (see ToolRegistry).
   *  AUTOMATIC_CAPABILITY: a real platform capability that runs on its own as part of a workflow (e.g.
   *  ticket delivery, booking creation) rather than being invoked by the model — still a genuine, working
   *  feature, just never fabricated as an LLM-callable tool it isn't. */
  kind: "AGENT_TOOL" | "AUTOMATIC_CAPABILITY";
}

const DISPLAY_NAMES: Record<string, { displayName: string; category: ToolCatalogCategory }> = {
  "travel.search_flights": { displayName: "Search Flights", category: "Search" },
  "travel.search_hotels": { displayName: "Search Hotels", category: "Search" },
  "travel.escalate": { displayName: "Escalate to Human", category: "Escalation" },
  "travel.create_lead": { displayName: "Create Lead", category: "CRM" },
  "travel.resend_ticket": { displayName: "Resend Ticket", category: "Booking" },
  "hr.create_ticket": { displayName: "Create HR Request", category: "CRM" },
  "hr.escalate": { displayName: "Escalate HR to Human", category: "Escalation" },
  "finance.create_record": { displayName: "Create Finance Record", category: "CRM" },
  "finance.escalate": { displayName: "Escalate Finance to Human", category: "Escalation" },
  "it.create_ticket": { displayName: "Create IT Ticket", category: "CRM" },
  "it.escalate": { displayName: "Escalate IT to Human", category: "Escalation" },
  "sales.create_lead": { displayName: "Create Sales Lead", category: "CRM" },
  "sales.escalate": { displayName: "Escalate Sales to Human", category: "Escalation" },
  "marketing.create_campaign": { displayName: "Create Marketing Campaign", category: "CRM" },
  "marketing.escalate": { displayName: "Escalate Marketing to Human", category: "Escalation" },
  "legal.create_notice": { displayName: "Create Legal Notice Record", category: "CRM" },
  "legal.escalate": { displayName: "Escalate Legal to Human", category: "Escalation" },
  "support.create_ticket": { displayName: "Create Support Ticket", category: "CRM" },
  "support.escalate": { displayName: "Escalate Support to Human", category: "Escalation" },
  "platform.memory.save": { displayName: "Save Memory", category: "Memory" },
  "platform.memory.search": { displayName: "Search Memory", category: "Memory" },
  "platform.demo.echo": { displayName: "Demo Echo", category: "Platform" }
};

/** Automatic platform capabilities that aren't invoked by the model as a discrete tool call, but are real
 *  working features an employee's workflow uses — surfaced here so the Tools page reflects everything
 *  reusable across employees, not only the LLM-callable subset. */
const AUTOMATIC_CAPABILITIES: ToolCatalogEntry[] = [
  {
    name: "platform.email_sender",
    displayName: "Email Sender",
    description:
      "Sends real emails (with PDF attachments) over SMTP once an employee's Email Delivery configuration is set — used for ticket delivery and resends.",
    category: "Communication",
    kind: "AUTOMATIC_CAPABILITY"
  },
  {
    name: "platform.whatsapp_sender",
    displayName: "WhatsApp Sender",
    description:
      "Sends real WhatsApp documents via a connected Meta Cloud API channel — used for ticket delivery and resends.",
    category: "Communication",
    kind: "AUTOMATIC_CAPABILITY"
  },
  {
    name: "platform.booking_engine",
    displayName: "Booking Engine",
    description:
      "Creates, tracks, and approves travel bookings end to end — passenger details, provider submission, PNR/ticket generation, and status tracking.",
    category: "Booking",
    kind: "AUTOMATIC_CAPABILITY"
  }
];

/** Builds the Tools page catalog from the live ToolRegistry (never a hand-maintained duplicate list) plus
 *  the automatic capabilities above — so a newly-registered tool always shows up without this file needing
 *  a matching update, and an unrecognized tool still renders (via its own raw name/description) rather
 *  than being silently dropped. */
export function buildToolCatalog(definitions: readonly ToolDefinition[]): ToolCatalogEntry[] {
  const agentTools: ToolCatalogEntry[] = definitions.map((definition) => {
    const known = DISPLAY_NAMES[definition.name];
    return {
      name: definition.name,
      displayName: known?.displayName ?? definition.name,
      description: definition.description,
      category: known?.category ?? "Platform",
      kind: "AGENT_TOOL"
    };
  });
  return [...agentTools, ...AUTOMATIC_CAPABILITIES];
}
