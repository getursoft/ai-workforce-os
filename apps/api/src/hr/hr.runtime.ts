import type {
  EmployeeDomainSpec,
  EmployeeEntities,
  EmployeeRuntimeConfig
} from "../employees/employee-runtime";

/** HR Employee — Priya: employee questions, policy guidance, onboarding and leave help, HR tickets. */
export const HR_EMPLOYEE_PLUGIN_SLUG = "hr-employee";
export const HR_STATE_MEMORY_KEY = "hr.ticket_state";
export const HR_REFERENCE_PREFIX = "HRT";

export const DEFAULT_HR_EMPLOYEE_CONFIG: EmployeeRuntimeConfig = {
  persona:
    "A friendly, efficient AI HR assistant who answers employee questions, guides onboarding and leave processes, and routes anything sensitive to human HR.",
  welcomeMessage: "Hi \u{1F44B}, I am your HR companion. May I know your name, please?",
  escalationContact: "support@ai-workforce-os.example",
  brandTone: "FRIENDLY",
  defaultCurrency: "USD",
  defaultLanguage: "en",
  businessHoursStart: null,
  businessHoursEnd: null,
  businessHoursTimezone: null
};

const TOPIC_PATTERN =
  /\b(leave|onboarding|policy|benefit|payroll|attendance|holiday|parental|maternity|paternity|sick|training|appraisal|grievance|reimbursement)\b/i;

function extractTopic(text: string, prior: string | null): string | null {
  const match = text.match(TOPIC_PATTERN);
  if (match && match[0]) return match[0].toLowerCase();
  return prior;
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

function buildHrRecommendation(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "your query";
  const name = entities.customerName ? entities.customerName.split(" ")[0] : "there";
  return [
    `Thanks ${name}! I've noted your question about **${topic}**.`,
    "",
    "I can help with general HR guidance, policy summaries, and the process steps. For leave requests, onboarding paperwork, or any sensitive matter (grievances, compensation changes, terminations), I'll prepare your request and route it to your human HR team — I never make final decisions on those.",
    "",
    "Here's what I captured:",
    `• Topic: ${topic}`,
    ...(typeof entities.details === "string" && entities.details
      ? [`• Details: ${entities.details}`]
      : [])
  ].join("\n");
}

function buildHrSummary(entities: EmployeeEntities): string {
  const topic = typeof entities.topic === "string" ? entities.topic : "HR query";
  return `HR request: ${topic}${typeof entities.details === "string" && entities.details ? ` — ${entities.details}` : ""}`;
}

export const HR_DOMAIN_SPEC: EmployeeDomainSpec = {
  slug: HR_EMPLOYEE_PLUGIN_SLUG,
  memoryKey: HR_STATE_MEMORY_KEY,
  providerName: "hr-employee",
  modelName: "hr-employee-v1",
  referencePrefix: HR_REFERENCE_PREFIX,
  artifactToolName: "hr.create_ticket",
  artifactNoun: "HR request",
  escalationContact: DEFAULT_HR_EMPLOYEE_CONFIG.escalationContact,
  intentHint:
    "HR domain: leave, onboarding, policy, benefits, payroll, attendance, appraisal, grievances, reimbursements.",
  fields: [
    {
      key: "topic",
      label: "the topic",
      ask: "Which HR topic is this about — leave, onboarding, policy, benefits, payroll, or something else?",
      extract: extractTopic
    },
    {
      key: "details",
      label: "the details",
      ask: "Could you share a bit more detail so I can help you best?",
      extract: extractDetails
    }
  ],
  buildRecommendation: (entities) => buildHrRecommendation(entities),
  buildSummary: (entities) => buildHrSummary(entities),
  openingActions: () => [
    { label: "Ask about leave policy" },
    { label: "Start onboarding" },
    { label: "Check benefits" },
    { label: "Raise a HR ticket" }
  ],
  infoAnswers: [
    {
      pattern: /\bleave\s*(policy|rules|balance|eligibility|request|apply)\b/i,
      answer: [
        "Here's how leave works at your organisation:",
        "",
        "• Leave types: casual, sick, and paid (annual) leave, plus parental leave.",
        "• Requests: submit through your HR portal — most requests are routed to your manager for approval.",
        "• Balances: your leave balance is visible on the HR portal; I can help check eligibility.",
        "• Sensitive cases (extended leave, exceptional circumstances) go to your human HR team.",
        "",
        "If you'd like, I can help you prepare a leave request now."
      ].join("\n")
    },
    {
      pattern: /\bonboard(?:ing)?\b/i,
      answer: [
        "Here's a quick onboarding guide:",
        "",
        "• Complete your joining formalities and KYC documents.",
        "• Set up your accounts and access (IT will help with systems).",
        "• Review the employee handbook and policies.",
        "• Meet your team and complete first-week orientation.",
        "",
        "I can help you prepare an onboarding support request if needed."
      ].join("\n")
    },
    {
      pattern: /\bbenefits?\b/i,
      answer: [
        "Your organisation offers standard benefits including medical insurance, paid leave, and professional development support.",
        "For plan-specific details or to raise a benefits request, I can prepare an HR request for you."
      ].join("\n")
    }
  ]
};

export type HrEmployeeEntities = EmployeeEntities;
