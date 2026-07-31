import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** Finance Employee — Arjun: reports, invoices, expense classification and budget questions. */
export const FINANCE_EMPLOYEE_PLUGIN_SLUG = "finance-employee";
export const FINANCE_STATE_MEMORY_KEY = "finance.record_state";
export const FINANCE_REFERENCE_PREFIX = "FIN";

export const DEFAULT_FINANCE_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI finance assistant who answers routine finance questions, supports reports, invoices and expense classification, and routes sensitive or high-value actions for human approval.",
  welcomeMessage: "Hi \u{1F44B}, I am your finance companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const TOPIC_PATTERN =
  /\b(expense|invoice|budget|report|reimburse|payment|tax|spend|variance|approval|purchase|forecast)\b/i;

function extractTopic(text: string, prior: string | null): string | null {
  const match = text.match(TOPIC_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
}

const AMOUNT_PATTERN = /(?:rs\.?\s*|inr\s*|usd\s*|\$\s*|₹\s*)?(\d[\d,.]{2,12})/i;

function extractAmount(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const match = text.match(AMOUNT_PATTERN);
  if (match && match[1]) return match[1].replace(/,/g, "");
  return null;
}

function extractDetails(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const cleaned = text
    .replace(/my name is [a-z\s.'-]+/i, "")
    .replace(/\b(i am|i'm)\s+[a-z\s.'-]+/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .trim();
  if (cleaned.length >= 6) return cleaned.slice(0, 500);
  return null;
}

function buildFinanceRecommendation(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "your query";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  const amount = typeof entities.amount === "string" ? entities.amount : null;
  return [
    `Thanks ${name}! I've noted your finance question about **${topic}**.`,
    "",
    "I can help with report summaries, invoice status checks, expense classification, and budget questions. Any payment, posting, or financially sensitive action always requires human approval within your existing finance controls — I never execute those on my own.",
    "",
    "Here's what I captured:",
    `• Topic: ${topic}`,
    ...(amount ? [`• Amount: ${amount}`] : []),
    ...(typeof entities.details === "string" && entities.details
      ? [`• Details: ${entities.details}`]
      : [])
  ].join("\n");
}

function buildFinanceSummary(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "Finance query";
  const amount = typeof entities.amount === "string" ? entities.amount : null;
  return `Finance request: ${topic}${amount ? ` — ${amount}` : ""}${typeof entities.details === "string" && entities.details ? ` (${entities.details})` : ""}`;
}

export const FINANCE_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: FINANCE_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: FINANCE_STATE_MEMORY_KEY,
  providerName: "finance-employee",
  modelName: "finance-employee-v1",
  referencePrefix: FINANCE_REFERENCE_PREFIX,
  artifactToolName: "finance.create_record",
  artifactNoun: "finance request",
  escalationContact: DEFAULT_FINANCE_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "Finance domain: expenses, invoices, budgets, reports, reimbursements, payments, taxes, spend variance, approvals.",
  fields: [
    {
      key: "topic",
      label: "the topic",
      ask: "Which finance topic is this about — expense, invoice, budget, report, or something else?",
      extract: extractTopic
    },
    {
      key: "amount",
      label: "the amount",
      ask: "Is there an amount involved? If so, please share it (e.g. 12500, $500).",
      extract: extractAmount,
      optional: true
    },
    {
      key: "details",
      label: "the details",
      ask: "Could you share a bit more detail so I can help you best?",
      extract: extractDetails
    }
  ],
  buildRecommendation: (entities) => buildFinanceRecommendation(entities),
  buildSummary: (entities) => buildFinanceSummary(entities),
  openingActions: () => [
    { label: "Summarise last quarter's spend" },
    { label: "Classify an expense" },
    { label: "Check an invoice status" },
    { label: "Ask about an approval threshold" }
  ],
  infoAnswers: [
    {
      pattern: /\b(expense|classify|category)\b/i,
      answer: [
        "Here's how expense classification works:",
        "",
        "• Expenses are categorised against your chart of accounts (travel, meals, supplies, software, etc.).",
        "• I can help classify an expense you describe — just tell me what it was for.",
        "• Payments and postings always require human approval within your finance controls.",
        "",
        "Want me to classify an expense for you?"
      ].join("\n")
    },
    {
      pattern: /\binvoice\b/i,
      answer: [
        "I can help with invoice status checks and simple invoice queries.",
        "For payment, posting, or exceptions, an authorised finance approver is required.",
        "Share the invoice reference if you have one, and I'll prepare a finance request."
      ].join("\n")
    },
    {
      pattern: /\b(approval|threshold|budget)\b/i,
      answer: [
        "Approval thresholds follow your organisation's finance policy: routine amounts route automatically, while higher-value or sensitive actions require an authorised approver.",
        "If you'd like the exact current threshold, I can prepare a finance request to confirm it."
      ].join("\n")
    }
  ]
};

export type FinanceEmployeeEntities = EmployeeEntities;
