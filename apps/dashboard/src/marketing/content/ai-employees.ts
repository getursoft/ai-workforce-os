export type IconColor = "blue" | "lavender" | "mint" | "cyan" | "saffron" | "pink";

export type EmployeeBadge = "Enterprise Ready" | "24×7 Available" | "AI Employee";

export interface AiEmployee {
  slug: string;
  name: string;
  role: string;
  department: string;
  iconColor: IconColor;
  badge: EmployeeBadge;
  summary: string;
  responsibilities: string[];
  exampleRequests: string[];
  outcomes: string[];
  capabilities: { title: string; description: string }[];
  worksWith: string[];
  handoffNote: string;
}

export const aiEmployees: AiEmployee[] = [
  {
    slug: "travel",
    name: "Aria",
    role: "Travel AI Employee",
    department: "Travel and Operations",
    iconColor: "blue",
    badge: "24×7 Available",
    summary:
      "Aria plans trips, builds itineraries and supports travellers and travel-desk teams from the first question to a booking-ready plan.",
    responsibilities: [
      "Understand traveller preferences, budget and constraints",
      "Build day-by-day itineraries across single or multi-city trips",
      "Estimate trip budgets across flights, stay, transport and activities",
      "Suggest hotels and destinations aligned to traveller intent",
      "Apply organisational travel policy to recommendations",
      "Capture traveller and lead details for the travel desk",
      "Hand off confirmed plans to booking systems or human agents",
    ],
    exampleRequests: [
      "Plan a 5-day trip to Kerala for a family of four under a fixed budget",
      "Suggest a 3-city business itinerary across Delhi, Singapore and Tokyo",
      "Compare mid-range hotel options near a client's office in Bengaluru",
      "Summarise our current international travel policy for a new joiner",
    ],
    outcomes: [
      "Faster response times for travel enquiries",
      "Consistent, policy-aligned itinerary suggestions",
      "Reduced manual research time for travel-desk staff",
      "Better qualified leads for travel sales teams",
    ],
    capabilities: [
      { title: "Trip planning", description: "Builds structured, day-wise plans from a short traveller brief." },
      { title: "Itinerary creation", description: "Produces shareable itineraries covering stays, transfers and activities." },
      { title: "Budget estimation", description: "Estimates likely trip cost ranges based on destination and preferences." },
      { title: "Hotel and destination suggestions", description: "Recommends options that match traveller intent and constraints." },
      { title: "Policy guidance", description: "Applies your organisation's travel policy to every recommendation." },
      { title: "Multi-city trip support", description: "Sequences complex, multi-destination itineraries in one conversation." },
    ],
    worksWith: ["Sales", "Operations", "Customer Support"],
    handoffNote:
      "Aria prepares plans, estimates and traveller information. Live booking, payment and ticketing execution depend on your connected booking systems and approved integrations, and remain subject to your organisation's controls.",
  },
  {
    slug: "hr",
    name: "Priya",
    role: "HR AI Employee",
    department: "Human Resources",
    iconColor: "lavender",
    badge: "Enterprise Ready",
    summary:
      "Priya answers employee questions, guides onboarding and leave processes, and routes anything sensitive to your human HR team.",
    responsibilities: [
      "Answer employee questions on policy, benefits and processes",
      "Guide new joiners through onboarding steps and documentation",
      "Explain leave balances, eligibility and request procedures",
      "Surface relevant internal HR documentation on demand",
      "Create and track HR tickets for issues that need follow-up",
      "Communicate updates to employees on open requests",
      "Escalate sensitive or judgement-based matters to human HR",
    ],
    exampleRequests: [
      "What is our parental leave policy for new fathers?",
      "Walk me through my first-week onboarding checklist",
      "How many casual leave days do I have left this year?",
      "Raise a ticket about a payslip discrepancy",
    ],
    outcomes: [
      "Faster answers to routine HR questions",
      "Smoother onboarding for new employees",
      "Fewer repetitive queries reaching HR staff",
      "Clear audit trail of employee requests",
    ],
    capabilities: [
      { title: "Employee query handling", description: "Responds instantly to common HR questions, day or night." },
      { title: "Policy assistance", description: "Explains company policy in plain language, grounded in your documents." },
      { title: "Onboarding support", description: "Guides new joiners through required steps and paperwork." },
      { title: "Leave guidance", description: "Clarifies balances, eligibility and request steps." },
      { title: "HR ticket creation", description: "Logs issues that require a human HR decision or action." },
      { title: "Escalation to human HR", description: "Recognises sensitive topics and routes them to your HR team." },
    ],
    worksWith: ["IT Support", "Finance", "Executive Support"],
    handoffNote:
      "Priya supports and informs employees but does not make final decisions on sensitive HR matters such as grievances, terminations or compensation changes — these are always routed to your human HR team.",
  },
  {
    slug: "finance",
    name: "Arjun",
    role: "Finance AI Employee",
    department: "Finance",
    iconColor: "mint",
    badge: "Enterprise Ready",
    summary:
      "Arjun helps finance teams and employees with reports, invoices, expense classification and budget questions, with approvals kept in human hands.",
    responsibilities: [
      "Answer routine financial questions from employees and managers",
      "Generate summarised reports from connected financial data",
      "Support invoice queries and status checks",
      "Classify expenses against your chart of accounts",
      "Summarise budgets and explain period-over-period variance",
      "Explain relevant finance policies and approval thresholds",
      "Route sensitive or high-value actions for human approval",
    ],
    exampleRequests: [
      "Summarise last quarter's marketing spend versus budget",
      "Why did travel expenses increase in the last reporting period?",
      "Classify this expense: client dinner during a sales trip",
      "What is our current invoice approval threshold?",
    ],
    outcomes: [
      "Quicker turnaround on routine finance questions",
      "More consistent expense classification",
      "Faster variance explanations for budget owners",
      "Reduced manual reporting effort for finance staff",
    ],
    capabilities: [
      { title: "Financial query assistance", description: "Answers common finance questions using connected data sources." },
      { title: "Report generation", description: "Produces readable summaries from underlying financial records." },
      { title: "Invoice support", description: "Helps track invoice status and resolve simple queries." },
      { title: "Expense classification", description: "Suggests categorisation aligned with your chart of accounts." },
      { title: "Budget summaries", description: "Presents budget position and variance in plain language." },
      { title: "Human approval for sensitive actions", description: "Defers payments, postings and exceptions to authorised staff." },
    ],
    worksWith: ["Operations", "Executive Support", "Sales"],
    handoffNote:
      "Arjun assists with analysis, summaries and classification. Payments, postings and any financially sensitive action always require human approval within your existing finance controls.",
  },
  {
    slug: "it-support",
    name: "Kabir",
    role: "IT Support AI Employee",
    department: "Information Technology",
    iconColor: "cyan",
    badge: "24×7 Available",
    summary:
      "Kabir handles first-line technical support, searches your knowledge base and triages incidents before escalating to your IT team.",
    responsibilities: [
      "Provide first-line technical support to employees",
      "Create and track IT support tickets",
      "Search your knowledge base for relevant troubleshooting steps",
      "Walk users through common troubleshooting procedures",
      "Guide employees on access requests and account issues",
      "Triage incidents by urgency and likely impact",
      "Escalate unresolved or high-priority issues to human IT staff",
      "Communicate known system status to affected users",
    ],
    exampleRequests: [
      "My laptop will not connect to the office VPN",
      "How do I request access to the shared finance drive?",
      "Log a ticket: printer on the 3rd floor is offline",
      "Is the customer portal currently experiencing an outage?",
    ],
    outcomes: [
      "Faster first response to IT issues",
      "Fewer routine tickets reaching human engineers",
      "Consistent triage and prioritisation of incidents",
      "Clearer communication during outages",
    ],
    capabilities: [
      { title: "Technical support", description: "Resolves common issues using guided troubleshooting." },
      { title: "Ticket handling", description: "Creates, updates and tracks IT tickets end to end." },
      { title: "Knowledge-base search", description: "Finds relevant internal articles instantly." },
      { title: "Troubleshooting", description: "Walks users through structured diagnostic steps." },
      { title: "User access guidance", description: "Explains access request processes and requirements." },
      { title: "Incident triage", description: "Assesses urgency and routes accordingly." },
      { title: "Escalation", description: "Hands complex or high-risk issues to human engineers." },
      { title: "System status communication", description: "Keeps users informed during known incidents." },
    ],
    worksWith: ["HR", "Operations", "Finance"],
    handoffNote:
      "Kabir resolves common issues and prepares context for your engineers. Access changes, infrastructure actions and security-sensitive requests are escalated to authorised IT staff.",
  },
  {
    slug: "sales",
    name: "Maya",
    role: "Sales AI Employee",
    department: "Sales",
    iconColor: "saffron",
    badge: "AI Employee",
    summary:
      "Maya qualifies leads, answers product questions, prepares reps for meetings and keeps CRM data current between human conversations.",
    responsibilities: [
      "Qualify inbound leads against your ideal customer profile",
      "Answer prospect questions on product capability and fit",
      "Follow up with leads who have gone quiet",
      "Prepare meeting briefs summarising prospect context",
      "Assist with first drafts of proposals and follow-up emails",
      "Hand qualified leads to your CRM with structured context",
      "Answer routine customer questions during the sales cycle",
      "Summarise pipeline patterns for sales leadership",
    ],
    exampleRequests: [
      "Qualify this lead based on our ideal customer profile",
      "Prepare a briefing note before my call with this prospect",
      "Draft a follow-up email for a prospect who went quiet",
      "Summarise this month's pipeline by stage and source",
    ],
    outcomes: [
      "Faster lead response times",
      "More consistent qualification across the funnel",
      "Reps arrive at meetings better prepared",
      "Cleaner, more current CRM data",
    ],
    capabilities: [
      { title: "Lead qualification", description: "Scores and filters leads against your defined criteria." },
      { title: "Product discovery", description: "Answers prospect questions grounded in your product content." },
      { title: "Follow-up support", description: "Keeps conversations warm with timely, relevant outreach." },
      { title: "CRM hand-off", description: "Passes structured lead and conversation context into your CRM." },
      { title: "Meeting preparation", description: "Summarises account history ahead of sales calls." },
      { title: "Proposal assistance", description: "Drafts first-pass proposals for human review and refinement." },
      { title: "Pipeline insights", description: "Surfaces patterns and risks across the sales pipeline." },
    ],
    worksWith: ["Marketing", "Finance", "Customer Support"],
    handoffNote:
      "Maya qualifies, informs and prepares — closing decisions, pricing exceptions and contractual commitments remain with your human sales team.",
  },
  {
    slug: "marketing",
    name: "Neha",
    role: "Marketing AI Employee",
    department: "Marketing",
    iconColor: "pink",
    badge: "AI Employee",
    summary:
      "Neha supports campaign planning, drafts on-brand content and summarises performance so your marketing team can focus on strategy.",
    responsibilities: [
      "Support campaign planning and messaging development",
      "Draft first versions of content across formats",
      "Research audience segments and messaging angles",
      "Maintain consistent brand voice across drafts",
      "Prepare social content aligned with campaign themes",
      "Summarise campaign performance in plain language",
      "Collaborate with human marketers through review cycles",
    ],
    exampleRequests: [
      "Draft three headline options for our upcoming product launch",
      "Summarise the performance of last month's email campaign",
      "Suggest messaging angles for a mid-market audience segment",
      "Draft a week of social posts for our webinar campaign",
    ],
    outcomes: [
      "Faster first drafts across content types",
      "More consistent brand voice across channels",
      "Clearer, faster performance summaries",
      "More campaign iterations in the same time",
    ],
    capabilities: [
      { title: "Campaign support", description: "Helps structure campaigns from brief to launch checklist." },
      { title: "Content assistance", description: "Drafts blog posts, emails, landing copy and more." },
      { title: "Audience research", description: "Synthesises audience signals into messaging guidance." },
      { title: "Messaging", description: "Shapes consistent value propositions across assets." },
      { title: "Social content", description: "Prepares platform-ready social copy drafts." },
      { title: "Performance summaries", description: "Turns campaign metrics into clear, readable summaries." },
      { title: "Brand consistency", description: "Applies your brand voice and guidelines to every draft." },
    ],
    worksWith: ["Sales", "Customer Support", "Executive Support"],
    handoffNote:
      "Neha drafts and researches; publishing, spend decisions and final brand sign-off stay with your marketing team.",
  },
  {
    slug: "legal",
    name: "Vikram",
    role: "Legal Document AI Employee",
    department: "Legal and Compliance",
    iconColor: "mint",
    badge: "Enterprise Ready",
    summary:
      "Vikram reads incoming legal and regulatory notifications for CA firms and advocates, and drafts structured replies ready for professional review and filing.",
    responsibilities: [
      "Monitor incoming legal, tax and regulatory notifications",
      "Summarise notices in plain language, with key dates highlighted",
      "Draft first-version replies to notices and regulatory correspondence",
      "Track response deadlines and flag matters approaching due dates",
      "Organise notices and drafts by client and matter",
      "Prepare client-facing summaries of notices and proposed responses",
      "Route every draft to a licensed CA or advocate before filing",
    ],
    exampleRequests: [
      "Draft a reply to this GST show-cause notice",
      "Summarise this income-tax scrutiny notice and suggest next steps",
      "Prepare a client update on this regulatory notice we just received",
      "What is the response deadline on this compliance notice?",
    ],
    outcomes: [
      "Faster first drafts on incoming notices",
      "Fewer missed response deadlines",
      "Consistent, well-organised notice-and-reply records per client",
      "More professional time freed for judgement and client work",
    ],
    capabilities: [
      { title: "Notification monitoring", description: "Watches connected inboxes and portals for new legal or regulatory notices." },
      { title: "Notice summarisation", description: "Turns dense legal and regulatory language into a clear, actionable summary." },
      { title: "Reply drafting", description: "Prepares a structured first-draft response ready for professional review." },
      { title: "Deadline tracking", description: "Flags upcoming response deadlines before they are missed." },
      { title: "Matter organisation", description: "Keeps notices, drafts and client context organised by matter." },
      { title: "Human review and filing safeguard", description: "Every draft is reviewed and filed by a licensed CA or advocate — never submitted automatically." },
    ],
    worksWith: ["Finance", "Operations", "Executive Support"],
    handoffNote:
      "Vikram drafts replies and tracks deadlines but never provides legal advice or files a submission — every draft is reviewed, finalised and filed by a licensed CA or advocate.",
  },
  {
    slug: "customer-support",
    name: "Ananya",
    role: "Customer Support AI Employee",
    department: "Customer Support",
    iconColor: "lavender",
    badge: "24×7 Available",
    summary:
      "Ananya answers customer questions, troubleshoots common issues and keeps support tickets moving around the clock, escalating anything that needs a human touch.",
    responsibilities: [
      "Answer routine customer questions from your knowledge base",
      "Troubleshoot common product or service issues",
      "Create and update support tickets with structured context",
      "Track ticket status and follow up with customers on open issues",
      "Identify frustrated or high-risk customers early",
      "Summarise recurring issues for the support and product teams",
      "Escalate complex or sensitive cases to human support agents",
    ],
    exampleRequests: [
      "A customer says their order hasn't arrived — what's the status?",
      "Walk this customer through resetting their account password",
      "Summarise the top 5 issues raised by customers this week",
      "Escalate this billing dispute to a human agent",
    ],
    outcomes: [
      "Faster first response on support tickets",
      "Round-the-clock coverage without added headcount",
      "Fewer routine tickets reaching human agents",
      "Earlier visibility into recurring or high-risk issues",
    ],
    capabilities: [
      { title: "Customer query handling", description: "Resolves common questions instantly, day or night." },
      { title: "Troubleshooting", description: "Walks customers through structured diagnostic steps." },
      { title: "Ticket management", description: "Creates, updates and tracks tickets end to end." },
      { title: "Status follow-up", description: "Keeps customers informed on the progress of open issues." },
      { title: "Issue trend summaries", description: "Surfaces recurring problems for support and product teams." },
      { title: "Escalation to human agents", description: "Recognises complex or sensitive cases and routes them appropriately." },
    ],
    worksWith: ["Sales", "Operations", "Marketing"],
    handoffNote:
      "Ananya resolves routine issues and prepares context for your team. Refunds, contractual exceptions and sensitive complaints are always escalated to a human support agent.",
  },
  {
    slug: "custom",
    name: "Your AI Employee",
    role: "Custom AI Employee",
    department: "Any Department",
    iconColor: "blue",
    badge: "AI Employee",
    summary:
      "Beyond the standard roles, AI Workforce OS lets you configure a custom AI employee shaped around your specific processes, terminology and tools.",
    responsibilities: [
      "Defined around your specific department or process",
      "Configured with your organisation's terminology and tone",
      "Connected to the knowledge sources you choose",
      "Given access to the specific tools it needs, and no more",
      "Scoped with approval rules that match your risk appetite",
      "Extended over time as your requirements evolve",
    ],
    exampleRequests: [
      "Build an AI employee for procurement vendor queries",
      "Create an AI employee for legal contract summarisation support",
      "Configure an AI employee for internal audit questions",
      "Design an AI employee for facilities and admin requests",
    ],
    outcomes: [
      "A role-fit AI employee instead of a generic assistant",
      "Faster time to value for niche or specialised workflows",
      "Consistent behaviour aligned to your internal standards",
      "Room to expand scope as trust and adoption grow",
    ],
    capabilities: [
      { title: "Custom scope", description: "Defined around the exact department, process or workflow you choose." },
      { title: "Configurable knowledge", description: "Grounded in the specific documents and systems you connect." },
      { title: "Configurable tools", description: "Given the precise tool access the role requires." },
      { title: "Configurable governance", description: "Approval rules and access levels set to match your policies." },
    ],
    worksWith: ["Any department you choose"],
    handoffNote:
      "Custom AI employees are scoped collaboratively with your team during onboarding, with clear boundaries on what they can and cannot do without human approval.",
  },
];

export const getAiEmployee = (slug: string) =>
  aiEmployees.find((employee) => employee.slug === slug);
