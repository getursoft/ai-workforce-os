import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** Legal Document Employee — Vikram: incoming notices, structured reply drafts, deadline tracking. */
export const LEGAL_EMPLOYEE_PLUGIN_SLUG = "legal-employee";
export const LEGAL_STATE_MEMORY_KEY = "legal.notice_state";
export const LEGAL_REFERENCE_PREFIX = "LEG";

export const DEFAULT_LEGAL_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A careful, professional AI legal document assistant who reads incoming legal and regulatory notifications and drafts structured replies ready for review and filing by a licensed CA or advocate.",
  welcomeMessage: "Hi \u{1F44B}, I am your legal document companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "PROFESSIONAL",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  defaultCountry: "India",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const NOTICE_TYPE_PATTERN =
  /\b(gst|income[\s-]?tax|tax|scrutiny|show[\s-]?cause|notice|demand|compliance|regulatory|assessment|summon|filing)\b/i;

function extractNoticeType(text: string, prior: string | null): string | null {
  const match = text.match(NOTICE_TYPE_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
}

const DEADLINE_PATTERN = /\b(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/i;

function extractDeadline(text: string, prior: string | null): string | null {
  const match = text.match(DEADLINE_PATTERN);
  if (match && match[0]) return match[0];
  return prior;
}

function extractSummary(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const cleaned = text
    .replace(/my name is [a-z\s.'-]+/i, "")
    .replace(/\b(i am|i'm)\s+[a-z\s.'-]+/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .trim();
  if (cleaned.length >= 6) return cleaned.slice(0, 500);
  return null;
}

function buildLegalRecommendation(entities: EmployeeEntities): string {
  const noticeType = typeof entities.noticeType === "string" ? entities.noticeType : "your notice";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  const deadline = typeof entities.deadline === "string" ? entities.deadline : null;
  return [
    `Thanks ${name}! I've recorded a **${noticeType}** notice${deadline ? ` with a response deadline of **${deadline}**` : ""}.`,
    "",
    "I can summarise the notice in plain language, track response deadlines, and draft a structured first-version reply. Every draft is reviewed and filed by a licensed CA or advocate — I never provide legal advice or file a submission on my own.",
    "",
    "Here's what I captured:",
    `• Notice type: ${noticeType}`,
    ...(deadline ? [`• Deadline: ${deadline}`] : []),
    ...(typeof entities.summary === "string" && entities.summary
      ? [`• Summary: ${entities.summary}`]
      : [])
  ].join("\n");
}

function buildLegalSummary(entities: EmployeeEntities): string {
  const noticeType = typeof entities.noticeType === "string" ? entities.noticeType : "Legal notice";
  const deadline = typeof entities.deadline === "string" ? entities.deadline : null;
  return `Legal notice: ${noticeType}${deadline ? ` (deadline ${deadline})` : ""}${typeof entities.summary === "string" && entities.summary ? ` — ${entities.summary}` : ""}`;
}

export const LEGAL_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: LEGAL_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: LEGAL_STATE_MEMORY_KEY,
  providerName: "legal-employee",
  modelName: "legal-employee-v1",
  referencePrefix: LEGAL_REFERENCE_PREFIX,
  artifactToolName: "legal.create_notice",
  artifactNoun: "legal notice record",
  escalationContact: DEFAULT_LEGAL_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "Legal domain: GST notices, income-tax scrutiny, show-cause notices, demands, compliance and regulatory notifications, response deadlines.",
  fields: [
    {
      key: "noticeType",
      label: "the notice type",
      ask: "What kind of notice is this — GST, income-tax scrutiny, show-cause, demand, or regulatory?",
      extract: extractNoticeType
    },
    {
      key: "deadline",
      label: "the response deadline",
      ask: "Is there a response deadline? If so, when is it?",
      extract: extractDeadline,
      optional: true
    },
    {
      key: "summary",
      label: "a short summary",
      ask: "Could you summarise the notice in your own words, or share the key points?",
      extract: extractSummary
    }
  ],
  buildRecommendation: (entities) => buildLegalRecommendation(entities),
  buildSummary: (entities) => buildLegalSummary(entities),
  openingActions: () => [
    { label: "Draft a reply to a GST notice" },
    { label: "Summarise an income-tax notice" },
    { label: "Check a response deadline" },
    { label: "Prepare a client update" }
  ],
  infoAnswers: [
    {
      pattern: /\b(gst|show.?cause|notice)\b/i,
      answer: [
        "I can help with legal and regulatory notices:",
        "",
        "• Summarise the notice in plain language, with key dates highlighted.",
        "• Track response deadlines.",
        "• Draft a structured first-version reply.",
        "",
        "Every draft is reviewed and filed by a licensed CA or advocate — I never provide legal advice or file a submission on my own.",
        "Share the notice type and deadline, and I'll prepare a notice record."
      ].join("\n")
    },
    {
      pattern: /\b(income[\s-]?tax|scrutiny|assessment)\b/i,
      answer: [
        "I can help prepare for income-tax scrutiny and assessment notices — summarising the notice and drafting a first-version response for your CA or advocate to review.",
        "Please share the notice type and any response deadline."
      ].join("\n")
    },
    {
      pattern: /\b(deadline|due|date)\b/i,
      answer: [
        "I track response deadlines on your legal notices and flag matters approaching their due dates.",
        "Share the notice and its deadline, and I'll record it and keep it on your radar."
      ].join("\n")
    }
  ]
};

export type LegalEmployeeEntities = EmployeeEntities;
