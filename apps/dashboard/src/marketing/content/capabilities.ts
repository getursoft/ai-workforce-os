export interface Capability {
  slug: string;
  title: string;
  description: string;
  details: string[];
}

export const capabilities: Capability[] = [
  {
    slug: "conversational-intelligence",
    title: "Conversational Intelligence",
    description:
      "Natural, context-aware conversation that understands intent, follows multi-turn discussions and adapts tone to your organisation.",
    details: [
      "Understands business context, not just keywords",
      "Maintains context across a multi-turn conversation",
      "Adapts tone and terminology to your organisation",
      "Handles ambiguity by asking clarifying questions",
    ],
  },
  {
    slug: "knowledge-grounded-responses",
    title: "Knowledge-Grounded Responses",
    description:
      "Answers are grounded in your organisation's documents, policies and systems rather than generic, unverified assumptions.",
    details: [
      "References your policies, playbooks and documentation",
      "Cites the internal source behind a response where relevant",
      "Flags when a confirmed answer is not available",
      "Keeps responses aligned with approved organisational content",
    ],
  },
  {
    slug: "tool-execution",
    title: "Tool Execution",
    description:
      "AI employees can call approved business tools and systems to complete real tasks, not just describe them.",
    details: [
      "Executes approved actions in connected systems",
      "Reads and writes structured data through controlled interfaces",
      "Operates within scoped, permissioned tool access",
      "Logs every tool action for later review",
    ],
  },
  {
    slug: "multi-step-task-handling",
    title: "Multi-Step Task Handling",
    description:
      "Complex requests are broken into ordered steps, tracked to completion, and reported back clearly.",
    details: [
      "Plans multi-step work from a single natural-language request",
      "Tracks progress across each step of a task",
      "Recovers gracefully when a step needs more information",
      "Summarises outcomes in plain language when complete",
    ],
  },
  {
    slug: "memory",
    title: "Memory",
    description:
      "AI employees remember relevant preferences and context so interactions improve over time rather than starting from zero.",
    details: [
      "Retains relevant preferences across conversations",
      "Recalls prior context for returning employees or customers",
      "Keeps memory scoped to what is relevant and permitted",
      "Supports resetting or correcting stored context",
    ],
  },
  {
    slug: "human-approval",
    title: "Human Approval",
    description:
      "Sensitive or high-impact actions are routed to a human for review before they are executed.",
    details: [
      "Configurable approval thresholds by task type",
      "Clear approval queues for designated reviewers",
      "Full context provided alongside each approval request",
      "Nothing sensitive executes without the required sign-off",
    ],
  },
  {
    slug: "collaboration",
    title: "Collaboration",
    description:
      "AI employees work alongside human teams and other AI employees, handing off work cleanly at the right moments.",
    details: [
      "Coordinates with other AI employees on cross-department tasks",
      "Hands off to human colleagues with full context attached",
      "Supports shared visibility into in-progress work",
      "Designed to extend teams, not replace them",
    ],
  },
  {
    slug: "reporting",
    title: "Reporting",
    description:
      "Clear, ongoing visibility into what AI employees are doing, how often, and the outcomes they support.",
    details: [
      "Usage and outcome dashboards by AI employee and department",
      "Trend reporting over time",
      "Exportable summaries for stakeholders",
      "Configurable reporting cadence",
    ],
  },
  {
    slug: "integration-connectivity",
    title: "Integration Connectivity",
    description:
      "Connects to the systems your teams already use, so AI employees work with your real data and tools.",
    details: [
      "Pre-built connectors for common business systems",
      "Custom API connectivity for internal tools",
      "Scoped, permissioned data access per integration",
      "Central visibility into connected systems",
    ],
  },
  {
    slug: "channel-support",
    title: "Channel Support",
    description:
      "AI employees can be reached through the channels your teams and customers already use.",
    details: [
      "Web chat for customers and public visitors",
      "Internal channels for employee-facing AI employees",
      "Email-based interaction for asynchronous requests",
      "Consistent behaviour across every supported channel",
    ],
  },
];
