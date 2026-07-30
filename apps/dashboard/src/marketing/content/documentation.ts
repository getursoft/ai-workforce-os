export interface DocSection {
  title: string;
  description: string;
  topics: string[];
}

export const docSections: DocSection[] = [
  {
    title: "Getting Started",
    description: "Set up your organisation and deploy your first AI employee.",
    topics: ["Creating your workspace", "Choosing your first AI employee", "Inviting your team", "Understanding roles and permissions"],
  },
  {
    title: "Configuring AI Employees",
    description: "Scope, tone and behaviour for each AI employee you deploy.",
    topics: ["Setting scope and responsibilities", "Configuring tone and terminology", "Defining escalation rules", "Testing before go-live"],
  },
  {
    title: "Knowledge and Memory",
    description: "Connect and manage the knowledge sources AI employees use.",
    topics: ["Connecting documents and wikis", "Managing knowledge freshness", "Understanding memory scope", "Resetting or correcting memory"],
  },
  {
    title: "Integrations",
    description: "Connect CRM, email, calendar, documents and custom systems.",
    topics: ["Connecting a CRM", "Setting up email and calendar", "Custom API connections", "Managing integration permissions"],
  },
  {
    title: "Governance and Approvals",
    description: "Configure the rules that decide what needs a human sign-off.",
    topics: ["Setting approval thresholds", "Managing approval queues", "Role-based access control", "Audit log basics"],
  },
  {
    title: "Analytics and Reporting",
    description: "Understand usage, outcomes and trends across your AI workforce.",
    topics: ["Reading your dashboard", "Exporting reports", "Setting a reporting cadence", "Department-level breakdowns"],
  },
];
