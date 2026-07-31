import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** Marketing Employee — Neha: campaign planning, on-brand content drafts, performance summaries. */
export const MARKETING_EMPLOYEE_PLUGIN_SLUG = "marketing-employee";
export const MARKETING_STATE_MEMORY_KEY = "marketing.campaign_state";
export const MARKETING_REFERENCE_PREFIX = "MKT";

export const DEFAULT_MARKETING_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI marketing assistant who supports campaign planning, drafts on-brand content and summarises performance so your marketing team can focus on strategy.",
  welcomeMessage: "Hi \u{1F44B}, I am your marketing companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const CHANNEL_PATTERN =
  /\b(email|social|linkedin|twitter|x|instagram|facebook|content|blog|video|webinar|seo|paid|ad|event|campaign)\b/i;

function extractChannel(text: string, prior: string | null): string | null {
  const match = text.match(CHANNEL_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
}

function extractGoals(text: string, prior: string | null): string | null {
  if (prior) return prior;
  const cleaned = text
    .replace(/my name is [a-z\s.'-]+/i, "")
    .replace(/\b(i am|i'm)\s+[a-z\s.'-]+/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .trim();
  if (cleaned.length >= 6) return cleaned.slice(0, 500);
  return null;
}

function buildMarketingRecommendation(entities: EmployeeEntities): string {
  const channel = typeof entities.channel === "string" ? entities.channel : "your campaign";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  return [
    `Thanks ${name}! I've noted your campaign brief for **${channel}**.`,
    "",
    "I can help structure the campaign, draft first-version content, and summarise performance. Publishing, spend decisions and final brand sign-off stay with your marketing team.",
    "",
    "Here's what I captured:",
    `• Channel: ${channel}`,
    ...(typeof entities.goals === "string" && entities.goals
      ? [`• Goals: ${entities.goals}`]
      : [])
  ].join("\n");
}

function buildMarketingSummary(entities: EmployeeEntities): string {
  const channel = typeof entities.channel === "string" ? entities.channel : "Marketing campaign";
  return `Marketing campaign: ${channel}${typeof entities.goals === "string" && entities.goals ? ` — ${entities.goals}` : ""}`;
}

export const MARKETING_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: MARKETING_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: MARKETING_STATE_MEMORY_KEY,
  providerName: "marketing-employee",
  modelName: "marketing-employee-v1",
  referencePrefix: MARKETING_REFERENCE_PREFIX,
  artifactToolName: "marketing.create_campaign",
  artifactNoun: "campaign brief",
  escalationContact: DEFAULT_MARKETING_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "Marketing domain: campaign planning, email, social, content, blogs, video, webinars, SEO, paid ads, events.",
  fields: [
    {
      key: "channel",
      label: "the channel",
      ask: "Which channel is this campaign for — email, social, content, webinar, paid, or something else?",
      extract: extractChannel
    },
    {
      key: "goals",
      label: "the goals",
      ask: "What are the main goals for this campaign?",
      extract: extractGoals
    }
  ],
  buildRecommendation: (entities) => buildMarketingRecommendation(entities),
  buildSummary: (entities) => buildMarketingSummary(entities),
  openingActions: () => [
    { label: "Plan an email campaign" },
    { label: "Draft social content" },
    { label: "Summarise campaign performance" },
    { label: "Prepare a webinar" }
  ],
  infoAnswers: [
    {
      pattern: /\b(campaign|plan|brief)\b/i,
      answer: [
        "I can help structure a campaign from brief to launch checklist:",
        "",
        "• Define the audience, channel, and goals.",
        "• Draft first-version content.",
        "• Outline measurement.",
        "",
        "Publishing and spend decisions stay with your marketing team. Want me to capture a campaign brief?"
      ].join("\n")
    },
    {
      pattern: /\b(content|copy|social|post)\b/i,
      answer: [
        "I can draft first-version content across email, social, blog, and webinar formats.",
        "Final brand sign-off and publishing stay with your marketing team.",
        "Tell me the channel and message, and I'll prepare a content brief."
      ].join("\n")
    },
    {
      pattern: /\b(performance|metrics|results|summary)\b/i,
      answer: [
        "I can summarise campaign performance from connected marketing data in plain language.",
        "If you'd like a campaign performance brief prepared, I can capture the request."
      ].join("\n")
    }
  ]
};

export type MarketingEmployeeEntities = EmployeeEntities;
