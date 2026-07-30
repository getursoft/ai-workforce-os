export interface DepartmentSolution {
  slug: string;
  name: string;
  summary: string;
  challenges: string[];
  howAiEmployeesHelp: string[];
  relatedEmployees: string[];
}

export const departmentSolutions: DepartmentSolution[] = [
  {
    slug: "customer-service",
    name: "Customer Service",
    summary:
      "Give customers instant, accurate answers around the clock while your support team focuses on complex, high-value cases.",
    challenges: [
      "Long response times during peak hours",
      "Repetitive questions consuming agent time",
      "Inconsistent answers across support channels",
    ],
    howAiEmployeesHelp: [
      "Answer common questions instantly using your knowledge base",
      "Triage and route complex issues to the right human agent",
      "Maintain consistent, on-brand responses at any hour",
    ],
    relatedEmployees: ["it-support", "sales"],
  },
  {
    slug: "operations",
    name: "Operations",
    summary:
      "Keep processes moving with AI employees that track tasks, surface bottlenecks and coordinate handoffs across teams.",
    challenges: [
      "Manual coordination across multiple teams and tools",
      "Delayed visibility into process status",
      "Repetitive administrative work",
    ],
    howAiEmployeesHelp: [
      "Track multi-step processes and flag what needs attention",
      "Coordinate handoffs between departments",
      "Summarise operational status for managers on demand",
    ],
    relatedEmployees: ["it-support", "finance"],
  },
  {
    slug: "sales",
    name: "Sales",
    summary:
      "Qualify leads faster, prepare reps for every meeting, and keep pipeline data current without manual entry.",
    challenges: [
      "Slow lead response times",
      "Reps spending hours on manual research and data entry",
      "Inconsistent qualification criteria",
    ],
    howAiEmployeesHelp: [
      "Qualify and prioritise inbound leads instantly",
      "Prepare account briefings ahead of meetings",
      "Keep CRM records current with structured hand-offs",
    ],
    relatedEmployees: ["sales", "marketing"],
  },
  {
    slug: "marketing",
    name: "Marketing",
    summary:
      "Move faster from brief to campaign with an AI employee that drafts content, researches audiences and reports on results.",
    challenges: [
      "Content demand outpacing team capacity",
      "Slow turnaround on campaign performance summaries",
      "Maintaining consistent brand voice at scale",
    ],
    howAiEmployeesHelp: [
      "Draft first-pass content across formats and channels",
      "Summarise campaign performance in plain language",
      "Apply consistent brand voice across every draft",
    ],
    relatedEmployees: ["marketing", "sales"],
  },
  {
    slug: "hr",
    name: "HR",
    summary:
      "Free your HR team from repetitive queries so they can focus on people, culture and complex employee matters.",
    challenges: [
      "High volume of repetitive policy questions",
      "Onboarding steps that are easy to miss",
      "Slow turnaround on simple HR requests",
    ],
    howAiEmployeesHelp: [
      "Answer policy and benefits questions instantly",
      "Guide new joiners through onboarding checklists",
      "Escalate sensitive matters to your human HR team",
    ],
    relatedEmployees: ["hr", "it-support"],
  },
  {
    slug: "finance",
    name: "Finance",
    summary:
      "Speed up routine reporting and query handling while keeping approvals firmly in human hands.",
    challenges: [
      "Manual effort producing routine reports",
      "Slow answers to budget and variance questions",
      "Inconsistent expense classification",
    ],
    howAiEmployeesHelp: [
      "Generate summarised reports from connected financial data",
      "Explain variance and budget position in plain language",
      "Route sensitive actions for human approval",
    ],
    relatedEmployees: ["finance"],
  },
  {
    slug: "it",
    name: "IT",
    summary:
      "Resolve common technical issues instantly and give your engineers better-triaged, better-documented escalations.",
    challenges: [
      "High volume of first-line support tickets",
      "Inconsistent incident triage",
      "Slow communication during outages",
    ],
    howAiEmployeesHelp: [
      "Resolve common issues through guided troubleshooting",
      "Triage and prioritise incidents automatically",
      "Keep employees informed during known outages",
    ],
    relatedEmployees: ["it-support"],
  },
  {
    slug: "travel",
    name: "Travel",
    summary:
      "Help travellers plan faster and give your travel desk consistent, policy-aligned recommendations.",
    challenges: [
      "Time-consuming manual itinerary research",
      "Inconsistent adherence to travel policy",
      "Slow response to traveller questions",
    ],
    howAiEmployeesHelp: [
      "Build itineraries and estimate budgets in minutes",
      "Apply organisational travel policy automatically",
      "Capture traveller requirements for booking hand-off",
    ],
    relatedEmployees: ["travel"],
  },
  {
    slug: "executive-support",
    name: "Executive Support",
    summary:
      "Give leadership fast, reliable summaries across departments without waiting on manual report compilation.",
    challenges: [
      "Fragmented reporting across departments",
      "Time lost compiling status updates",
      "Delayed visibility into cross-functional risk",
    ],
    howAiEmployeesHelp: [
      "Summarise cross-department status on demand",
      "Surface trends from connected AI employee activity",
      "Prepare briefing material ahead of leadership reviews",
    ],
    relatedEmployees: ["finance", "hr"],
  },
];

export interface OrgTypeSolution {
  slug: string;
  name: string;
  summary: string;
  points: string[];
}

export const orgTypeSolutions: OrgTypeSolution[] = [
  {
    slug: "startups",
    name: "Start-ups",
    summary:
      "Get enterprise-grade support functions running from day one, without hiring a full team for every role.",
    points: [
      "Deploy an AI employee for support, sales or operations in days",
      "Scale coverage as customer and employee volume grows",
      "Keep costs predictable while extending team capacity",
    ],
  },
  {
    slug: "growing-businesses",
    name: "Growing Businesses",
    summary:
      "Add capacity across departments as you scale, without proportional headcount growth in every function.",
    points: [
      "Cover expanding support and operations workload",
      "Standardise processes across new teams and locations",
      "Free existing staff to focus on higher-value work",
    ],
  },
  {
    slug: "enterprises",
    name: "Enterprises",
    summary:
      "Deploy governed AI employees across business units with the access control and auditability large organisations require.",
    points: [
      "Role-based access and configurable governance controls",
      "Multi-department deployment from a single operating layer",
      "Auditability designed for enterprise oversight",
    ],
  },
  {
    slug: "travel-companies",
    name: "Travel Companies",
    summary:
      "Handle trip planning volume at scale with a Travel AI Employee grounded in your policies and preferred partners.",
    points: [
      "Consistent itinerary quality at higher volume",
      "Policy-aligned recommendations across every enquiry",
      "Faster lead capture and hand-off to booking teams",
    ],
  },
  {
    slug: "service-businesses",
    name: "Service Businesses",
    summary:
      "Keep client-facing questions answered promptly while your team focuses on delivery and relationships.",
    points: [
      "Faster response to client queries",
      "Consistent service quality across engagements",
      "More time for your team to focus on client outcomes",
    ],
  },
  {
    slug: "internal-corporate-teams",
    name: "Internal Corporate Teams",
    summary:
      "Support internal functions like HR, IT and finance with AI employees that reduce repetitive workload.",
    points: [
      "Faster resolution of routine internal requests",
      "Consistent policy application across the organisation",
      "More time for internal teams to focus on strategic work",
    ],
  },
];
