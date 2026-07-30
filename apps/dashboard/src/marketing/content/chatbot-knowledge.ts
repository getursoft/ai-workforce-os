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
  "I do not have a confirmed answer for that yet. I can help you contact the AI Workforce OS team for clarification.";

export const knowledgeBase: KnowledgeEntry[] = [
  {
    id: "what-is-platform",
    keywords: ["what is ai workforce os", "what does ai workforce os do", "platform overview", "what is this platform", "overview"],
    answer:
      "AI Workforce OS is the operating system for AI employees — it lets organisations hire, manage and scale specialised AI employees that work across departments, grounded in company knowledge, connected to real tools, and supervised by human teams.",
    actions: [{ label: "Explore the Platform", href: "/platform", type: "primary" }],
    relatedQuestions: ["What is an AI employee?", "How is this different from a chatbot?"],
  },
  {
    id: "what-is-ai-employee",
    keywords: ["what is an ai employee", "ai employee mean", "define ai employee"],
    answer:
      "An AI employee is a role-based AI worker configured for a specific department — like Travel, HR, Finance, IT Support, Sales or Marketing. It uses your organisational knowledge, connects to real tools, remembers relevant context, and hands off sensitive decisions to humans.",
    actions: [{ label: "Explore AI Employees", href: "/meet-ai-employees", type: "primary" }],
    relatedQuestions: ["Which AI employees are available?", "How do AI employees work with human teams?"],
  },
  {
    id: "ai-employee-roles",
    keywords: ["which ai employees", "list of ai employees", "roles available", "types of ai employees"],
    answer:
      "AI Workforce OS offers Travel, HR, Finance, IT Support, Sales and Marketing AI employees, plus Custom AI Employees configured around your own workflows.",
    actions: [{ label: "View All AI Employees", href: "/meet-ai-employees", type: "primary" }],
  },
  {
    id: "travel-employee",
    keywords: ["travel ai employee", "trip planning", "itinerary", "travel agent"],
    answer:
      "The Travel AI Employee plans trips, builds itineraries, estimates budgets and suggests hotels and destinations aligned to policy. Live booking and payment depend on your connected booking systems and approved integrations.",
    actions: [{ label: "View Travel AI Employee", href: "/meet-ai-employees/travel", type: "primary" }],
  },
  {
    id: "hr-employee",
    keywords: ["hr ai employee", "hr assistant", "onboarding", "leave policy"],
    answer:
      "The HR AI Employee answers employee questions, supports onboarding, explains leave and policy, creates HR tickets, and escalates sensitive matters to your human HR team.",
    actions: [{ label: "View HR AI Employee", href: "/meet-ai-employees/hr", type: "primary" }],
  },
  {
    id: "finance-employee",
    keywords: ["finance ai employee", "invoices", "expense", "budget", "variance"],
    answer:
      "The Finance AI Employee helps with financial queries, report generation, invoice support, expense classification and budget summaries — with human approval required for sensitive actions.",
    actions: [{ label: "View Finance AI Employee", href: "/meet-ai-employees/finance", type: "primary" }],
  },
  {
    id: "it-employee",
    keywords: ["it support ai employee", "it ticket", "troubleshoot", "incident"],
    answer:
      "The IT Support AI Employee handles first-line technical support, ticket creation, knowledge-base search, troubleshooting and incident triage, escalating to human engineers when needed.",
    actions: [{ label: "View IT Support AI Employee", href: "/meet-ai-employees/it-support", type: "primary" }],
  },
  {
    id: "sales-employee",
    keywords: ["sales ai employee", "lead qualification", "crm", "pipeline"],
    answer:
      "The Sales AI Employee qualifies leads, supports product discovery, follows up with prospects, preps reps for meetings and hands qualified leads to your CRM.",
    actions: [{ label: "View Sales AI Employee", href: "/meet-ai-employees/sales", type: "primary" }],
  },
  {
    id: "marketing-employee",
    keywords: ["marketing ai employee", "campaign", "content assistance", "social content"],
    answer:
      "The Marketing AI Employee supports campaign planning, drafts content, researches audiences and summarises performance while keeping your brand voice consistent.",
    actions: [{ label: "View Marketing AI Employee", href: "/meet-ai-employees/marketing", type: "primary" }],
  },
  {
    id: "not-a-chatbot",
    keywords: ["different from chatbot", "basic chatbot", "why not just a chatbot"],
    answer:
      "Unlike a basic chatbot, AI employees are grounded in your organisational knowledge, retain memory across conversations, execute tasks through connected tools, follow human approval rules, and collaborate with your teams — not just answer isolated questions.",
    actions: [{ label: "See Platform Capabilities", href: "/platform/capabilities", type: "primary" }],
  },
  {
    id: "integrations",
    keywords: ["integration", "connect", "crm", "systems", "tools connect"],
    answer:
      "AI Workforce OS connects to CRM, email, calendar, documents, databases, cloud platforms, collaboration tools, travel systems, support platforms and custom APIs. Each integration is marked Available, In Development, Planned or Custom Integration.",
    actions: [{ label: "View Integrations", href: "/connect", type: "primary" }],
  },
  {
    id: "security",
    keywords: ["security", "governance", "access control", "audit", "compliance", "soc 2", "iso 27001", "gdpr"],
    answer:
      "AI Workforce OS is designed to support enterprise security requirements with configurable governance controls, role-based access, audit logging and human approval workflows. We do not claim specific compliance certifications unless formally confirmed — contact our team for the latest status.",
    actions: [{ label: "View Security Page", href: "/security", type: "primary" }],
  },
  {
    id: "pricing",
    keywords: ["pricing", "cost", "price", "plan", "how much"],
    answer:
      "AI Workforce OS offers Starter, Growth and Enterprise plans, scaled by the number of AI employees, integrations and governance features you need. Enterprise pricing is handled through our sales team.",
    actions: [{ label: "View Pricing", href: "/pricing", type: "primary" }],
  },
  {
    id: "enterprise",
    keywords: ["enterprise", "multi-tenant", "role-based access", "large organisation"],
    answer:
      "For enterprises, AI Workforce OS offers multi-tenant architecture, role-based access, configurable governance, auditability, private integrations and dedicated onboarding support.",
    actions: [{ label: "View Enterprise Solutions", href: "/solutions/enterprise", type: "primary" }],
  },
  {
    id: "collaboration",
    keywords: ["collaborate", "partnership", "work with human", "human team"],
    answer:
      "AI employees are built to work alongside human teams — handling repetitive and high-volume work while handing off sensitive decisions, approvals and relationship-building to your people.",
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
      "You can book a guided demo where our team configures a representative AI employee around a real use case from your organisation.",
    actions: [{ label: "Book a Demo", href: "/book-demo", type: "primary" }],
  },
  {
    id: "which-employee-fits",
    keywords: ["which ai employee should i use", "recommend an ai employee", "suited for my business"],
    answer:
      "It depends on where you feel the most repetitive workload today. Travel suits trip planning teams, HR and Finance suit internal operations, IT Support suits technical helpdesks, and Sales or Marketing suit revenue teams. Tell us more about your team on the Contact page and we can help you choose.",
    actions: [
      { label: "Explore AI Employees", href: "/meet-ai-employees", type: "primary" },
      { label: "Contact Us", href: "/contact", type: "secondary" },
    ],
  },
  {
    id: "knowledge-connect",
    keywords: ["connect knowledge", "organisational knowledge", "documents", "company data"],
    answer:
      "You connect your documents, policies and systems as knowledge sources so AI employees ground their answers in your organisation's real content rather than general assumptions.",
    actions: [{ label: "Knowledge and Memory", href: "/platform/knowledge", type: "primary" }],
  },
  {
    id: "login",
    keywords: ["login", "log in", "sign in", "existing customer", "access my account"],
    answer:
      "Existing customers can log in to access the AI Workforce OS application from the Login page.",
    actions: [{ label: "Go to Login", href: "/login", type: "primary" }],
  },
];

export const pageContext: Record<string, { greeting: string; suggestedPrompts: string[] }> = {
  "/": {
    greeting: "Hi! I'm here to help you explore AI Workforce OS. Ask me about AI employees, capabilities, pricing or how to get started.",
    suggestedPrompts: ["What is an AI employee?", "Which AI employees are available?", "How is this different from a chatbot?"],
  },
  "/platform": {
    greeting: "Ask me about the AI Workforce OS platform — knowledge, memory, tools, approvals and analytics.",
    suggestedPrompts: ["What is the platform's operating layer?", "How does organisational knowledge work?", "How do approvals work?"],
  },
  "/meet-ai-employees": {
    greeting: "Ask me which AI employee may suit your organisation, or what any of them can do.",
    suggestedPrompts: ["Which AI employee should I use?", "What can the Sales AI Employee do?", "How do AI employees work with human teams?"],
  },
  "/meet-ai-employees/travel": {
    greeting: "Ask me how the Travel AI Employee can plan trips, estimate budgets and support travel customers.",
    suggestedPrompts: ["What can the Travel AI Employee plan?", "Can it book flights directly?", "How does it apply travel policy?"],
  },
  "/meet-ai-employees/hr": {
    greeting: "Ask me how the HR AI Employee supports onboarding, policy questions and employee requests.",
    suggestedPrompts: ["What HR questions can it answer?", "How does onboarding support work?", "When does it escalate to a human?"],
  },
  "/meet-ai-employees/finance": {
    greeting: "Ask me how the Finance AI Employee helps with reports, invoices and budgets.",
    suggestedPrompts: ["Can it generate financial reports?", "How does expense classification work?", "Who approves sensitive actions?"],
  },
  "/meet-ai-employees/it-support": {
    greeting: "Ask me how the IT Support AI Employee handles tickets and troubleshooting.",
    suggestedPrompts: ["How does incident triage work?", "Can it resolve access requests?", "When does it escalate to engineers?"],
  },
  "/meet-ai-employees/sales": {
    greeting: "Ask me how the Sales AI Employee qualifies leads and supports your pipeline.",
    suggestedPrompts: ["How does lead qualification work?", "Can it prepare me for a meeting?", "How does CRM hand-off work?"],
  },
  "/meet-ai-employees/marketing": {
    greeting: "Ask me how the Marketing AI Employee supports campaigns and content.",
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
    greeting: "Ask me about access control, tenant isolation and how AI Workforce OS approaches security.",
    suggestedPrompts: ["Is this SOC 2 certified?", "How is data access controlled?", "How are sensitive actions approved?"],
  },
  "/connect": {
    greeting: "Ask me which systems AI Workforce OS can connect to.",
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
    suggestedPrompts: ["How do I access my account?", "What is AI Workforce OS?", "I forgot my password"],
  },
};

const rootPageContext = pageContext["/"];
if (!rootPageContext) throw new Error("Missing '/' entry in pageContext content.");
export const defaultPageContext = rootPageContext;
