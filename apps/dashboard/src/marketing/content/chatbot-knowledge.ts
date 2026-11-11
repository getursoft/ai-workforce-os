export interface ChatAction {
  label: string;
  href: string;
  type: "primary" | "secondary";
}

export interface KnowledgeEntry {
  id: string;
  keywords: string[];
  answer: string;
  actions?: ChatAction[];
  relatedQuestions?: string[];
}

export const FALLBACK_ANSWER =
  "I do not have a confirmed answer for that yet. I can help you contact the Krevia.ai team for clarification.";

export const knowledgeBase: KnowledgeEntry[] = [
  {
    id: "what-is-platform",
    keywords: ["what is ai workforce os", "what does ai workforce os do", "platform overview", "what is this platform", "overview"],
    answer:
      "Krevia.ai is the operating system for AI agents — it lets organisations hire, manage and scale specialised AI agents that work across departments, grounded in company knowledge, connected to real tools, and supervised by human teams.",
    actions: [{ label: "Explore the Platform", href: "/platform", type: "primary" }],
    relatedQuestions: ["What is an AI agent?", "How is this different from a chatbot?"],
  },
  {
    id: "what-is-ai-employee",
    keywords: ["what is an ai employee", "ai employee mean", "define ai employee", "what is an ai agent", "ai agent mean", "define ai agent"],
    answer:
      "An AI agent is a role-based AI worker configured for a specific department — like Travel, HR, Finance, IT Support, Sales or Marketing. It uses your organisational knowledge, connects to real tools, remembers relevant context, and hands off sensitive decisions to humans.",
    actions: [{ label: "Explore AI Agents", href: "/meet-ai-agents", type: "primary" }],
    relatedQuestions: ["Which AI agents are available?", "How do AI agents work with human teams?"],
  },
  {
    id: "ai-employee-roles",
    keywords: ["which ai employees", "list of ai employees", "roles available", "types of ai employees", "which ai agents", "list of ai agents", "types of ai agents"],
    answer:
      "Krevia.ai offers Travel, HR, Finance, IT Support, Sales and Marketing AI agents, plus Custom AI Agents configured around your own workflows.",
    actions: [{ label: "View All AI Agents", href: "/meet-ai-agents", type: "primary" }],
  },
  {
    id: "travel-employee",
    keywords: ["travel ai employee", "trip planning", "itinerary", "travel agent", "travel ai agent"],
    answer:
      "The Travel AI Agent plans trips, builds itineraries, estimates budgets and suggests hotels and destinations aligned to policy. Live booking and payment depend on your connected booking systems and approved integrations.",
    actions: [{ label: "View Travel AI Agent", href: "/meet-ai-agents/travel", type: "primary" }],
  },
  {
    id: "hr-employee",
    keywords: ["hr ai employee", "hr assistant", "onboarding", "leave policy", "hr ai agent"],
    answer:
      "The HR AI Agent answers agent questions, supports onboarding, explains leave and policy, creates HR tickets, and escalates sensitive matters to your human HR team.",
    actions: [{ label: "View HR AI Agent", href: "/meet-ai-agents/hr", type: "primary" }],
  },
  {
    id: "finance-employee",
    keywords: ["finance ai employee", "invoices", "expense", "budget", "variance", "finance ai agent"],
    answer:
      "The Finance AI Agent helps with financial queries, report generation, invoice support, expense classification and budget summaries — with human approval required for sensitive actions.",
    actions: [{ label: "View Finance AI Agent", href: "/meet-ai-agents/finance", type: "primary" }],
  },
  {
    id: "it-employee",
    keywords: ["it support ai employee", "it ticket", "troubleshoot", "incident", "it support ai agent"],
    answer:
      "The IT Support AI Agent handles first-line technical support, ticket creation, knowledge-base search, troubleshooting and incident triage, escalating to human engineers when needed.",
    actions: [{ label: "View IT Support AI Agent", href: "/meet-ai-agents/it-support", type: "primary" }],
  },
  {
    id: "sales-employee",
    keywords: ["sales ai employee", "lead qualification", "crm", "pipeline", "sales ai agent"],
    answer:
      "The Sales AI Agent qualifies leads, supports product discovery, follows up with prospects, preps reps for meetings and hands qualified leads to your CRM.",
    actions: [{ label: "View Sales AI Agent", href: "/meet-ai-agents/sales", type: "primary" }],
  },
  {
    id: "marketing-employee",
    keywords: ["marketing ai employee", "campaign", "content assistance", "social content", "marketing ai agent"],
    answer:
      "The Marketing AI Agent supports campaign planning, drafts content, researches audiences and summarises performance while keeping your brand voice consistent.",
    actions: [{ label: "View Marketing AI Agent", href: "/meet-ai-agents/marketing", type: "primary" }],
  },
  {
    id: "not-a-chatbot",
    keywords: ["different from chatbot", "basic chatbot", "why not just a chatbot"],
    answer:
      "Unlike a basic chatbot, AI agents are grounded in your organisational knowledge, retain memory across conversations, execute tasks through connected tools, follow human approval rules, and collaborate with your teams — not just answer isolated questions.",
    actions: [{ label: "See Platform Capabilities", href: "/platform/capabilities", type: "primary" }],
  },
  {
    id: "integrations",
    keywords: ["integration", "connect", "crm", "systems", "tools connect"],
    answer:
      "Krevia.ai connects to CRM, email, calendar, documents, databases, cloud platforms, collaboration tools, travel systems, support platforms and custom APIs. Each integration is marked Available, In Development, Planned or Custom Integration.",
    actions: [{ label: "View Integrations", href: "/connect", type: "primary" }],
  },
  {
    id: "security",
    keywords: ["security", "governance", "access control", "audit", "compliance", "soc 2", "iso 27001", "gdpr"],
    answer:
      "Krevia.ai is designed to support enterprise security requirements with configurable governance controls, role-based access, audit logging and human approval workflows. We do not claim specific compliance certifications unless formally confirmed — contact our team for the latest status.",
    actions: [{ label: "View Security Page", href: "/security", type: "primary" }],
  },
  {
    id: "pricing",
    keywords: ["pricing", "cost", "price", "plan", "how much"],
    answer:
      "Krevia.ai offers Starter, Growth and Enterprise plans, scaled by the number of AI agents, integrations and governance features you need. Enterprise pricing is handled through our sales team.",
    actions: [{ label: "View Pricing", href: "/pricing", type: "primary" }],
  },
  {
    id: "enterprise",
    keywords: ["enterprise", "multi-tenant", "role-based access", "large organisation"],
    answer:
      "For enterprises, Krevia.ai offers multi-tenant architecture, role-based access, configurable governance, auditability, private integrations and dedicated onboarding support.",
    actions: [{ label: "View Enterprise Solutions", href: "/solutions/enterprise", type: "primary" }],
  },
  {
    id: "collaboration",
    keywords: ["collaborate", "partnership", "work with human", "human team"],
    answer:
      "AI agents are built to work alongside human teams — handling repetitive and high-volume work while handing off sensitive decisions, approvals and relationship-building to your people.",
    actions: [{ label: "Book a Demo", href: "/book-demo", type: "primary" }],
  },
  {
    id: "roadmap",
    keywords: ["roadmap", "future", "coming soon", "next features"],
    answer:
      "Our roadmap focuses on deepening integrations, expanding department coverage and strengthening governance and analytics. Specific timelines are shared directly with customers during onboarding conversations.",
    actions: [{ label: "Contact Us", href: "/contact", type: "secondary" }],
  },
  {
    id: "demo",
    keywords: ["demo", "book a demo", "schedule a call", "talk to sales"],
    answer:
      "You can book a guided demo where our team configures a representative AI agent around a real use case from your organisation.",
    actions: [{ label: "Book a Demo", href: "/book-demo", type: "primary" }],
  },
  {
    id: "which-employee-fits",
    keywords: ["which ai employee should i use", "recommend an ai employee", "suited for my business", "which ai agent should i use", "recommend an ai agent"],
    answer:
      "It depends on where you feel the most repetitive workload today. Travel suits trip planning teams, HR and Finance suit internal operations, IT Support suits technical helpdesks, and Sales or Marketing suit revenue teams. Tell us more about your team on the Contact page and we can help you choose.",
    actions: [
      { label: "Explore AI Agents", href: "/meet-ai-agents", type: "primary" },
      { label: "Contact Us", href: "/contact", type: "secondary" },
    ],
  },
  {
    id: "knowledge-connect",
    keywords: ["connect knowledge", "organisational knowledge", "documents", "company data"],
    answer:
      "You connect your documents, policies and systems as knowledge sources so AI agents ground their answers in your organisation's real content rather than general assumptions.",
    actions: [{ label: "Knowledge and Memory", href: "/platform/knowledge", type: "primary" }],
  },
  {
    id: "login",
    keywords: ["login", "log in", "sign in", "existing customer", "access my account"],
    answer:
      "Existing customers can log in to access the Krevia.ai application from the Login page.",
    actions: [{ label: "Go to Login", href: "/login", type: "primary" }],
  },
];

export const pageContext: Record<string, { greeting: string; suggestedPrompts: string[] }> = {
  "/": {
    greeting: "Hi! I'm here to help you explore Krevia.ai. Ask me about AI agents, capabilities, pricing or how to get started.",
    suggestedPrompts: ["What is an AI agent?", "Which AI agents are available?", "How is this different from a chatbot?"],
  },
  "/platform": {
    greeting: "Ask me about the Krevia.ai platform — knowledge, memory, tools, approvals and analytics.",
    suggestedPrompts: ["What is the platform's operating layer?", "How does organisational knowledge work?", "How do approvals work?"],
  },
  "/meet-ai-agents": {
    greeting: "Ask me which AI agent may suit your organisation, or what any of them can do.",
    suggestedPrompts: ["Which AI agent should I use?", "What can the Sales AI Agent do?", "How do AI agents work with human teams?"],
  },
  "/meet-ai-agents/travel": {
    greeting: "Ask me how the Travel AI Agent can plan trips, estimate budgets and support travel customers.",
    suggestedPrompts: ["What can the Travel AI Agent plan?", "Can it book flights directly?", "How does it apply travel policy?"],
  },
  "/meet-ai-agents/hr": {
    greeting: "Ask me how the HR AI Agent supports onboarding, policy questions and employee requests.",
    suggestedPrompts: ["What HR questions can it answer?", "How does onboarding support work?", "When does it escalate to a human?"],
  },
  "/meet-ai-agents/finance": {
    greeting: "Ask me how the Finance AI Agent helps with reports, invoices and budgets.",
    suggestedPrompts: ["Can it generate financial reports?", "How does expense classification work?", "Who approves sensitive actions?"],
  },
  "/meet-ai-agents/it-support": {
    greeting: "Ask me how the IT Support AI Agent handles tickets and troubleshooting.",
    suggestedPrompts: ["How does incident triage work?", "Can it resolve access requests?", "When does it escalate to engineers?"],
  },
  "/meet-ai-agents/sales": {
    greeting: "Ask me how the Sales AI Agent qualifies leads and supports your pipeline.",
    suggestedPrompts: ["How does lead qualification work?", "Can it prepare me for a meeting?", "How does CRM hand-off work?"],
  },
  "/meet-ai-agents/marketing": {
    greeting: "Ask me how the Marketing AI Agent supports campaigns and content.",
    suggestedPrompts: ["Can it draft campaign content?", "How does it keep brand voice consistent?", "Can it summarise performance?"],
  },
  "/pricing": {
    greeting: "Ask me which plan may suit your organisation.",
    suggestedPrompts: ["What is included in the Growth plan?", "How is pricing determined?", "How do I get Enterprise pricing?"],
  },
  "/solutions/enterprise": {
    greeting: "Ask me about governance, access control and enterprise deployment.",
    suggestedPrompts: ["What governance controls are available?", "Is this multi-tenant?", "How does enterprise onboarding work?"],
  },
  "/security": {
    greeting: "Ask me about access control, tenant isolation and how Krevia.ai approaches security.",
    suggestedPrompts: ["Is this SOC 2 certified?", "How is data access controlled?", "How are sensitive actions approved?"],
  },
  "/connect": {
    greeting: "Ask me which systems Krevia.ai can connect to.",
    suggestedPrompts: ["Do you integrate with Salesforce?", "What is the status of your CRM integrations?", "Can you build a custom integration?"],
  },
  "/contact": {
    greeting: "Ask me anything, or let me help you get in touch with the right team.",
    suggestedPrompts: ["How do I book a demo?", "What is your support email?", "Who should I contact about partnerships?"],
  },
  "/book-demo": {
    greeting: "Ask me what to expect from a demo, or any question before you book.",
    suggestedPrompts: ["What happens during a demo?", "How long does a demo take?", "Who should join the call?"],
  },
  "/login": {
    greeting: "Need help signing in or exploring the platform first? Ask me anything.",
    suggestedPrompts: ["How do I access my account?", "What is Krevia.ai?", "I forgot my password"],
  },
};

const rootPageContext = pageContext["/"];
if (!rootPageContext) throw new Error("Missing '/' entry in pageContext content.");
export const defaultPageContext = rootPageContext;
