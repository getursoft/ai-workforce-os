import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** Customer Support Employee — Ananya: answers, troubleshooting, tickets, escalation. */
export const CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG = "customer-support-employee";
export const CUSTOMER_SUPPORT_STATE_MEMORY_KEY = "support.ticket_state";
export const CUSTOMER_SUPPORT_REFERENCE_PREFIX = "SUP";

export const DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI customer support assistant who answers customer questions, troubleshoots common issues and keeps support tickets moving around the clock.",
  welcomeMessage: "Hi \u{1F44B}, I am your support companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const TOPIC_PATTERN =
  /\b(order|refund|return|billing|payment|account|password|login|delivery|shipping|product|subscription|bug|error|charge|cancel)\b/i;

function extractTopic(text: string, prior: string | null): string | null {
  const match = text.match(TOPIC_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
}

function extractDescription(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const cleaned = text
    .replace(/my name is [a-z\s.'-]+/i, "")
    .replace(/\b(i am|i'm)\s+[a-z\s.'-]+/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .trim();
  if (cleaned.length >= 6) return cleaned.slice(0, 500);
  return null;
}

function buildSupportRecommendation(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "your issue";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  return [
    `Thanks ${name}! I've noted your request about **${topic}**.`,
    "",
    "I can help troubleshoot common issues and keep your ticket moving. Refunds, contractual exceptions and sensitive complaints are always escalated to a human support agent.",
    "",
    "Here's what I captured:",
    `• Topic: ${topic}`,
    ...(typeof entities.description === "string" && entities.description
      ? [`• Description: ${entities.description}`]
      : [])
  ].join("\n");
}

function buildSupportSummary(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "Support request";
  return `Support request: ${topic}${typeof entities.description === "string" && entities.description ? ` — ${entities.description}` : ""}`;
}

export const CUSTOMER_SUPPORT_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: CUSTOMER_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: CUSTOMER_SUPPORT_STATE_MEMORY_KEY,
  providerName: "customer-support-employee",
  modelName: "customer-support-employee-v1",
  referencePrefix: CUSTOMER_SUPPORT_REFERENCE_PREFIX,
  artifactToolName: "support.create_ticket",
  artifactNoun: "support ticket",
  escalationContact: DEFAULT_CUSTOMER_SUPPORT_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "Customer support domain: orders, refunds, returns, billing, payments, accounts, passwords, login, delivery, shipping, products, subscriptions, errors.",
  fields: [
    {
      key: "topic",
      label: "the topic",
      ask: "Which topic is this about — an order, refund, billing, account, delivery, or something else?",
      extract: extractTopic
    },
    {
      key: "description",
      label: "a description",
      ask: "Could you describe what happened so I can help you best?",
      extract: extractDescription
    }
  ],
  buildRecommendation: (entities) => buildSupportRecommendation(entities),
  buildSummary: (entities) => buildSupportSummary(entities),
  openingActions: () => [
    { label: "Where is my order?" },
    { label: "Request a refund" },
    { label: "Reset my password" },
    { label: "Report a bug" }
  ],
  infoAnswers: [
    {
      pattern: /\b(order|delivery|shipping|status)\b/i,
      answer: [
        "I can help track your order or delivery.",
        "Share your order reference and what you're seeing, and I'll raise a support ticket with the details — a human agent will follow up with the exact status."
      ].join("\n")
    },
    {
      pattern: /\b(refund|return)\b/i,
      answer: [
        "Refunds and returns are handled by our support team.",
        "I can prepare a ticket with your order details and reason. Refunds always require a human agent to complete.",
        "What's the order reference and reason?"
      ].join("\n")
    },
    {
      pattern: /\b(password|login|account)\b/i,
      answer: [
        "For account and password help, I can prepare a support ticket and route it to a human agent.",
        "Security-sensitive requests are always handled by a human support agent."
      ].join("\n")
    }
  ]
};

export type CustomerSupportEmployeeEntities = EmployeeEntities;
