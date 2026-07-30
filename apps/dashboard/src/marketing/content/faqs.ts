export interface Faq {
  question: string;
  answer: string;
  category: "General" | "Platform" | "Security" | "Pricing" | "Integrations";
}

export const faqs: Faq[] = [
  {
    category: "General",
    question: "What is AI Workforce OS?",
    answer:
      "AI Workforce OS is a platform that lets organisations hire, manage and scale specialised AI employees. These AI employees perform business tasks, answer questions, use company knowledge, interact with tools, and collaborate with human teams across departments such as travel, HR, finance, IT, sales and marketing.",
  },
  {
    category: "General",
    question: "What is an AI employee?",
    answer:
      "An AI employee is a role-based AI worker configured for a specific department or function. Unlike a generic chatbot, an AI employee is grounded in your organisational knowledge, connected to relevant tools, aware of context and memory, and designed to hand off sensitive decisions to human colleagues.",
  },
  {
    category: "General",
    question: "How is this different from a basic chatbot?",
    answer:
      "A basic chatbot typically answers isolated questions with no memory, no tool access and no organisational grounding. AI employees on AI Workforce OS retain relevant context, execute multi-step tasks, use approved tools, apply human approval where needed, and collaborate with both human teams and other AI employees.",
  },
  {
    category: "Platform",
    question: "Can AI employees complete tasks, not just answer questions?",
    answer:
      "Yes. AI employees can execute approved actions through connected tools and systems, handle multi-step tasks, and track progress until completion, all within the access and approval boundaries your organisation configures.",
  },
  {
    category: "Platform",
    question: "Do AI employees replace human staff?",
    answer:
      "No. AI employees are designed to support and extend human teams by handling repetitive and high-volume work, so your people can focus on decisions, relationships and judgement calls that need a human touch.",
  },
  {
    category: "Platform",
    question: "How does organisational knowledge work?",
    answer:
      "You connect your documents, policies and systems as knowledge sources. AI employees ground their responses in this content rather than relying on unverified general knowledge, and clearly indicate when a confirmed answer is not available.",
  },
  {
    category: "Integrations",
    question: "What systems can AI Workforce OS connect to?",
    answer:
      "The platform supports integration categories including CRM, email, calendar, documents, databases, cloud platforms, collaboration tools, travel systems, support platforms and custom APIs. Availability varies by integration; see the Integrations page for current status.",
  },
  {
    category: "Security",
    question: "How is data access controlled?",
    answer:
      "Access is governed through role-based permissions, scoped tool access and configurable approval workflows. Sensitive or high-impact actions can be routed to a human reviewer before execution.",
  },
  {
    category: "Security",
    question: "Is AI Workforce OS certified for SOC 2, ISO 27001 or GDPR?",
    answer:
      "AI Workforce OS is designed to support enterprise security requirements with configurable governance controls and an integration-ready architecture. We do not claim specific compliance certifications unless they have been formally confirmed — please contact our team for the current status of any certification you require.",
  },
  {
    category: "Pricing",
    question: "How is AI Workforce OS priced?",
    answer:
      "Pricing is structured around Starter, Growth and Enterprise plans based on the number of AI employees, integrations and governance features you need. Contact our sales team for a plan tailored to your organisation.",
  },
  {
    category: "Pricing",
    question: "Can I try AI Workforce OS before committing?",
    answer:
      "The best starting point is a guided demo, where our team configures a representative AI employee around a real use case from your organisation so you can evaluate fit before making a decision.",
  },
  {
    category: "General",
    question: "How can my organisation collaborate with AI Workforce OS?",
    answer:
      "We work closely with customers during onboarding to scope AI employees around real workflows, connect relevant knowledge and systems, and configure the right approval boundaries. Reach out through our Contact page or book a demo to start the conversation.",
  },
];
