import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** Sales Employee — Maya: lead qualification, product questions, meeting prep, CRM hand-off. */
export const SALES_EMPLOYEE_PLUGIN_SLUG = "sales-employee";
export const SALES_STATE_MEMORY_KEY = "sales.lead_state";
export const SALES_REFERENCE_PREFIX = "SAL";

export const DEFAULT_SALES_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI sales assistant who qualifies leads, answers product questions, prepares reps for meetings and keeps CRM data current.",
  welcomeMessage: "Hi \u{1F44B}, I am your sales companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const INTEREST_PATTERN =
  /\b(product|pricing|quote|order|demo|trial|purchase|subscription|plan|buy|schedule|proposal)\b/i;

function extractInterest(text: string, prior: string | null): string | null {
  const match = text.match(INTEREST_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
}

function extractNotes(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const cleaned = text
    .replace(/my name is [a-z\s.'-]+/i, "")
    .replace(/\b(i am|i'm)\s+[a-z\s.'-]+/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .trim();
  if (cleaned.length >= 6) return cleaned.slice(0, 500);
  return null;
}

function buildSalesRecommendation(entities: EmployeeEntities): string {
  const interest = typeof entities.interest === "string" ? entities.interest : "your enquiry";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  return [
    `Thanks ${name}! I've noted your interest in **${interest}**.`,
    "",
    "I can answer product questions, prepare meeting briefs, and qualify your enquiry against what we offer. Closing decisions, pricing exceptions and contractual commitments remain with your human sales team.",
    "",
    "Here's what I captured:",
    `• Interest: ${interest}`,
    ...(typeof entities.notes === "string" && entities.notes
      ? [`• Notes: ${entities.notes}`]
      : [])
  ].join("\n");
}

function buildSalesSummary(entities: EmployeeEntities): string {
  const interest = typeof entities.interest === "string" ? entities.interest : "Sales enquiry";
  return `Sales lead: ${interest}${typeof entities.notes === "string" && entities.notes ? ` — ${entities.notes}` : ""}`;
}

export const SALES_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: SALES_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: SALES_STATE_MEMORY_KEY,
  providerName: "sales-employee",
  modelName: "sales-employee-v1",
  referencePrefix: SALES_REFERENCE_PREFIX,
  artifactToolName: "sales.create_lead",
  artifactNoun: "sales lead",
  escalationContact: DEFAULT_SALES_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "Sales domain: product information, pricing, quotes, orders, demos, trials, subscriptions, proposals.",
  fields: [
    {
      key: "interest",
      label: "your interest",
      ask: "What are you interested in — a product, pricing, a quote, a demo, or something else?",
      extract: extractInterest
    },
    {
      key: "notes",
      label: "a little more detail",
      ask: "Could you share a little more detail so I can prepare the right information for you?",
      extract: extractNotes
    }
  ],
  buildRecommendation: (entities) => buildSalesRecommendation(entities),
  buildSummary: (entities) => buildSalesSummary(entities),
  openingActions: () => [
    { label: "Ask about a product" },
    { label: "Request a quote" },
    { label: "Book a demo" },
    { label: "Check an order" }
  ],
  infoAnswers: [
    {
      pattern: /\b(product|capability|feature|plan)\b/i,
      answer: [
        "I can help with product questions and capability fit.",
        "Tell me what you're evaluating and I'll note your interest and prepare a sales handoff — a sales representative can walk you through the specifics.",
        "Closing decisions, pricing exceptions, and contractual commitments stay with your human sales team."
      ].join("\n")
    },
    {
      pattern: /\b(quote|pricing|price)\b/i,
      answer: [
        "I can prepare a quote request for you.",
        "Pricing exceptions and final quotes are confirmed by the sales team.",
        "Share what you need, and I'll create the request."
      ].join("\n")
    },
    {
      pattern: /\b(demo|trial)\b/i,
      answer: [
        "I can book a demo or trial for you.",
        "Let me capture your details and interest, and the sales team will schedule it."
      ].join("\n")
    }
  ]
};

export type SalesEmployeeEntities = EmployeeEntities;
