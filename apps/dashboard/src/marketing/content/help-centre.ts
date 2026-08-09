export interface HelpTopic {
  category: string;
  question: string;
  answer: string;
}

export const helpTopics: HelpTopic[] = [
  {
    category: "Account",
    question: "How do I invite teammates to my organisation?",
    answer: "Workspace administrators can invite teammates from the organisation settings area of the Krevia.ai application, assigning a role that determines what they can configure.",
  },
  {
    category: "Account",
    question: "How do I reset my password?",
    answer: "Use the \"Forgot password\" link on the login page to receive a secure reset link at your registered email address.",
  },
  {
    category: "AI Employees",
    question: "Can I change an AI employee's scope after deployment?",
    answer: "Yes. Scope, knowledge sources, tool access and approval rules can all be adjusted after go-live as your needs evolve.",
  },
  {
    category: "AI Employees",
    question: "How do I add a new AI employee?",
    answer: "From your workspace, choose a role template — Travel, HR, Finance, IT Support, Sales, Marketing or Custom — and configure it around your knowledge sources and tools.",
  },
  {
    category: "Knowledge",
    question: "What happens if an AI employee doesn't know the answer?",
    answer: "It will say so directly rather than guessing, and can offer to route the question to your team for a confirmed answer.",
  },
  {
    category: "Billing",
    question: "How does billing work across plans?",
    answer: "Plans are scoped around the number of AI employees, integrations and governance features you need. Contact our sales team for a plan tailored to your organisation.",
  },
  {
    category: "Security",
    question: "Who can see AI employee activity logs?",
    answer: "Activity and audit logs are visible to workspace administrators and any roles you explicitly grant access to, in line with your configured permissions.",
  },
  {
    category: "Integrations",
    question: "What do integration statuses mean?",
    answer: "Available means the integration is live today. In Development and Planned reflect upcoming work. Custom Integration means it can be built for your specific systems through our governed API layer.",
  },
];
