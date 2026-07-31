import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** IT Support Employee — Kabir: first-line technical support, knowledge-base search, incident triage. */
export const IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG = "it-support-employee";
export const IT_SUPPORT_STATE_MEMORY_KEY = "it.ticket_state";
export const IT_SUPPORT_REFERENCE_PREFIX = "ITS";

export const DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI IT support assistant who handles first-line technical support, searches your knowledge base and triages incidents before escalating to your IT team.",
  welcomeMessage: "Hi \u{1F44B}, I am your IT support companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const CATEGORY_PATTERN =
  /\b(vpn|network|password|login|access|software|hardware|laptop|email|printer|outage|account|install|wifi|slowness|device)\b/i;

function extractCategory(text: string, prior: string | null): string | null {
  const match = text.match(CATEGORY_PATTERN);
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

function buildItRecommendation(entities: EmployeeEntities): string {
  const category = typeof entities.category === "string" ? entities.category : "your issue";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  return [
    `Thanks ${name}! I've noted your issue under **${category}**.`,
    "",
    "I can walk you through common troubleshooting steps and search your knowledge base. Access changes, infrastructure actions and security-sensitive requests are escalated to your authorised IT staff.",
    "",
    "Here's what I captured:",
    `• Category: ${category}`,
    ...(typeof entities.description === "string" && entities.description
      ? [`• Description: ${entities.description}`]
      : [])
  ].join("\n");
}

function buildItSummary(entities: EmployeeEntities): string {
  const category = typeof entities.category === "string" ? entities.category : "IT issue";
  return `IT support request: ${category}${typeof entities.description === "string" && entities.description ? ` — ${entities.description}` : ""}`;
}

export const IT_SUPPORT_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: IT_SUPPORT_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: IT_SUPPORT_STATE_MEMORY_KEY,
  providerName: "it-support-employee",
  modelName: "it-support-employee-v1",
  referencePrefix: IT_SUPPORT_REFERENCE_PREFIX,
  artifactToolName: "it.create_ticket",
  artifactNoun: "IT support ticket",
  escalationContact: DEFAULT_IT_SUPPORT_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "IT support domain: VPN, network, password reset, login, access requests, software installation, hardware, laptop, email, printer, outages.",
  fields: [
    {
      key: "category",
      label: "the category",
      ask: "Which category best fits the issue — VPN/network, password/login, access, software, hardware, or something else?",
      extract: extractCategory
    },
    {
      key: "description",
      label: "a description",
      ask: "Could you describe what's happening so I can help you best?",
      extract: extractDescription
    }
  ],
  buildRecommendation: (entities) => buildItRecommendation(entities),
  buildSummary: (entities) => buildItSummary(entities),
  openingActions: () => [
    { label: "My VPN is not working" },
    { label: "Reset my password" },
    { label: "Request access to a drive" },
    { label: "Log a printer issue" }
  ],
  infoAnswers: [
    {
      pattern: /\bvpn\b/i,
      answer: [
        "Here are some common VPN troubleshooting steps:",
        "",
        "• Make sure you're on the office or approved network.",
        "• Check your VPN client is the latest version and signed in.",
        "• Restart the VPN client and try again.",
        "• If it still fails, log an IT ticket and I'll route it to the IT team with the context.",
        "",
        "Want me to create an IT ticket for this?"
      ].join("\n")
    },
    {
      pattern: /\b(password|reset|login)\b/i,
      answer: [
        "Password resets are handled through the IT access process:",
        "",
        "• Use the self-service password reset on the IT portal.",
        "• If that fails, log an access request and the IT team will assist.",
        "• Never share your password with anyone.",
        "",
        "I can prepare the access request for you."
      ].join("\n")
    },
    {
      pattern: /\b(access|drive|permission|folder)\b/i,
      answer: [
        "Access requests are routed through IT: you'll need to confirm the resource (drive, folder, system) and your reason.",
        "Access changes are always approved by authorised IT staff.",
        "I can prepare the request for you."
      ].join("\n")
    }
  ]
};

export type ItSupportEmployeeEntities = EmployeeEntities;
