export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  readTime: string;
  publishedAt: string;
  content: string[];
}

export const blogPosts: BlogPost[] = [
  {
    slug: "what-is-an-ai-employee",
    title: "What Is an AI Employee, Really?",
    excerpt: "Beyond the buzzword: what separates a role-based AI employee from a general-purpose chatbot.",
    category: "Product",
    readTime: "5 min read",
    publishedAt: "2026-05-12",
    content: [
      "The term \"AI employee\" gets used loosely across the industry, so it's worth being precise about what it means on Krevia.ai.",
      "An AI employee is a role-based AI worker configured for a specific department — Travel, HR, Finance, IT Support, Sales or Marketing, or a custom role you define. It is grounded in your organisation's real knowledge, connected to the tools relevant to its role, and built to hand off sensitive decisions to a human colleague.",
      "That's a meaningfully different shape from a general chatbot. A chatbot answers a question and forgets it. An AI employee remembers relevant context, executes multi-step work through connected systems, and operates inside approval rules your organisation sets.",
      "The result isn't a novelty — it's closer to onboarding a new team member with a narrow, well-defined job description than deploying a generic assistant.",
    ],
  },
  {
    slug: "chatbot-vs-ai-employee",
    title: "Chatbot vs. AI Employee: Where the Line Actually Sits",
    excerpt: "A practical breakdown of the capability gap between conversational bots and accountable AI workers.",
    category: "Product",
    readTime: "6 min read",
    publishedAt: "2026-04-28",
    content: [
      "Most disappointment with AI tools traces back to a mismatch: teams deploy a chatbot expecting the outcomes of an employee.",
      "A basic chatbot is stateless by default, has no access to your organisation's systems, and cannot execute a task — only describe how one might be done.",
      "An AI employee, by contrast, is built around four things: grounded knowledge, tool access, memory, and human approval. Those four together are what let it actually finish work rather than just discuss it.",
      "When evaluating any AI tool for a real department, it's worth asking directly: can it remember, can it act, and does it know when to ask a human? If the answer to any of those is no, you likely have a chatbot, not an AI employee.",
    ],
  },
  {
    slug: "governance-without-slowing-down",
    title: "Governance Without Slowing Everything Down",
    excerpt: "How configurable approval rules let AI employees move fast on routine work and pause on anything sensitive.",
    category: "Security",
    readTime: "4 min read",
    publishedAt: "2026-04-10",
    content: [
      "The instinct to lock everything behind manual approval is understandable, but it defeats the purpose of deploying an AI employee in the first place.",
      "Krevia.ai instead lets you set approval thresholds by task type. Routine, low-risk actions run automatically. Anything financially sensitive, externally visible, or irreversible routes to a human reviewer with full context attached.",
      "This is configured once, reviewed periodically, and adjusted as trust in a given AI employee grows — not a binary switch between 'fully autonomous' and 'fully manual'.",
    ],
  },
  {
    slug: "first-90-days-with-an-ai-employee",
    title: "The First 90 Days With an AI Employee",
    excerpt: "What a typical onboarding timeline looks like from initial scope to steady-state operation.",
    category: "Customer Success",
    readTime: "7 min read",
    publishedAt: "2026-03-22",
    content: [
      "Deploying an AI employee well is less about the technology and more about scoping the first 90 days deliberately.",
      "In the first two weeks, we typically scope the role narrowly around one or two real workflows, connect the relevant knowledge sources, and set conservative approval thresholds.",
      "Over the following month, usage data reveals where the AI employee is reliable and where it should escalate more often — that feedback loop is where most of the tuning happens.",
      "By day 90, most teams have expanded scope modestly, loosened select approval rules where trust has been earned, and started planning a second AI employee for an adjacent workflow.",
    ],
  },
  {
    slug: "connecting-organisational-knowledge",
    title: "Connecting Organisational Knowledge the Right Way",
    excerpt: "Practical guidance on choosing which documents and systems to connect first.",
    category: "Product",
    readTime: "5 min read",
    publishedAt: "2026-03-05",
    content: [
      "Not every document needs to be connected on day one. Start with the sources your team already treats as the single source of truth — policy documents, a well-maintained wiki, or a canonical spreadsheet.",
      "Grounding quality improves faster from a small set of trusted sources than from a large set of inconsistent ones.",
      "As confidence grows, additional sources can be layered in, with each one scoped to the AI employees that actually need it rather than shared indiscriminately.",
    ],
  },
  {
    slug: "roadmap-update-mid-2026",
    title: "Roadmap Update: What We're Building Next",
    excerpt: "A high-level look at where integrations, governance and analytics are headed.",
    category: "Company",
    readTime: "4 min read",
    publishedAt: "2026-02-18",
    content: [
      "We're continuing to expand our integration library, with several CRM and support-platform connectors moving from development into general availability over the coming months.",
      "On governance, we're deepening configurable approval workflows so multi-step tasks can request approval mid-task rather than only at completion.",
      "Analytics is gaining department-level benchmarking, so leaders can compare AI employee impact across teams over time.",
      "As always, specific timelines are shared directly with customers during onboarding conversations, since rollout pacing varies by integration.",
    ],
  },
];

export const getBlogPost = (slug: string) => blogPosts.find((post) => post.slug === slug);
