export type IntegrationStatus = "Available" | "In Development" | "Planned" | "Custom Integration";

export interface IntegrationCategory {
  name: string;
  description: string;
  items: { name: string; status: IntegrationStatus }[];
}

export const integrationCategories: IntegrationCategory[] = [
  {
    name: "CRM",
    description: "Keep customer and pipeline data flowing between AI employees and your CRM.",
    items: [
      { name: "Salesforce", status: "In Development" },
      { name: "HubSpot", status: "In Development" },
      { name: "Zoho CRM", status: "Planned" },
      { name: "Custom CRM", status: "Custom Integration" },
    ],
  },
  {
    name: "Email",
    description: "Send, read and organise email as part of an AI employee's workflow.",
    items: [
      { name: "Microsoft Outlook", status: "In Development" },
      { name: "Google Workspace Mail", status: "In Development" },
      { name: "Custom SMTP / IMAP", status: "Custom Integration" },
    ],
  },
  {
    name: "Calendar",
    description: "Coordinate meetings, availability and scheduling across teams.",
    items: [
      { name: "Google Calendar", status: "In Development" },
      { name: "Microsoft Outlook Calendar", status: "In Development" },
      { name: "Calendly", status: "Planned" },
    ],
  },
  {
    name: "Documents",
    description: "Ground responses in the documents your organisation already relies on.",
    items: [
      { name: "Google Drive", status: "Available" },
      { name: "SharePoint", status: "In Development" },
      { name: "Notion", status: "Planned" },
      { name: "Confluence", status: "Planned" },
    ],
  },
  {
    name: "Databases",
    description: "Connect AI employees to structured operational and analytical data.",
    items: [
      { name: "PostgreSQL", status: "Available" },
      { name: "MySQL", status: "Available" },
      { name: "Snowflake", status: "Planned" },
    ],
  },
  {
    name: "Cloud Platforms",
    description: "Deploy within your existing cloud footprint and identity model.",
    items: [
      { name: "Microsoft Azure", status: "In Development" },
      { name: "Amazon Web Services", status: "In Development" },
      { name: "Google Cloud", status: "Planned" },
    ],
  },
  {
    name: "Collaboration Tools",
    description: "Meet employees and teams where they already communicate.",
    items: [
      { name: "Slack", status: "In Development" },
      { name: "Microsoft Teams", status: "In Development" },
    ],
  },
  {
    name: "Travel Systems",
    description: "Support the Travel AI Employee with connected booking and rate data.",
    items: [
      { name: "Global Distribution Systems", status: "Planned" },
      { name: "Hotel Rate Providers", status: "Planned" },
      { name: "Custom Travel APIs", status: "Custom Integration" },
    ],
  },
  {
    name: "Support Platforms",
    description: "Sync tickets and conversations with your existing support stack.",
    items: [
      { name: "Zendesk", status: "In Development" },
      { name: "Freshdesk", status: "Planned" },
      { name: "Jira Service Management", status: "Planned" },
    ],
  },
  {
    name: "Custom APIs",
    description: "Connect any internal system through a governed, permissioned API layer.",
    items: [
      { name: "REST API Connector", status: "Available" },
      { name: "Webhook Actions", status: "Available" },
      { name: "Bespoke Internal Systems", status: "Custom Integration" },
    ],
  },
];
