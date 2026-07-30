export interface NavLink {
  label: string;
  href: string;
  description?: string;
}

export interface NavColumn {
  label: string;
  href: string;
  links: NavLink[];
}

export const primaryNav: NavColumn[] = [
  {
    label: "Platform",
    href: "/platform",
    links: [
      { label: "Platform Overview", href: "/platform", description: "The operating layer for AI employees" },
      { label: "Capabilities", href: "/platform/capabilities", description: "What the platform can do" },
      { label: "Knowledge and Memory", href: "/platform/knowledge", description: "Grounded in your organisation" },
      { label: "Integrations", href: "/platform/integrations", description: "Connect your existing systems" },
      { label: "Security", href: "/platform/security", description: "Governance and access control" },
      { label: "Analytics", href: "/platform/analytics", description: "Visibility into AI employee work" },
    ],
  },
  {
    label: "AI Employees",
    href: "/meet-ai-employees",
    links: [
      { label: "Travel AI Employee", href: "/meet-ai-employees/travel", description: "Trip planning and itineraries" },
      { label: "HR AI Employee", href: "/meet-ai-employees/hr", description: "Policies, onboarding and queries" },
      { label: "Finance AI Employee", href: "/meet-ai-employees/finance", description: "Reports, invoices and budgets" },
      { label: "IT Support AI Employee", href: "/meet-ai-employees/it-support", description: "Tickets and troubleshooting" },
      { label: "Sales AI Employee", href: "/meet-ai-employees/sales", description: "Lead qualification and CRM" },
      { label: "Marketing AI Employee", href: "/meet-ai-employees/marketing", description: "Campaigns and content" },
      { label: "Legal Document AI Employee", href: "/meet-ai-employees/legal", description: "Notice review and reply drafting" },
      { label: "Customer Support AI Employee", href: "/meet-ai-employees/customer-support", description: "Tickets and troubleshooting" },
      { label: "Custom AI Employees", href: "/meet-ai-employees/custom", description: "Purpose-built for your workflows" },
    ],
  },
  {
    label: "Solutions",
    href: "/solutions",
    links: [
      { label: "By Department", href: "/solutions", description: "Solutions mapped to every team" },
      { label: "For Start-ups", href: "/solutions/startups", description: "Lean teams, outsized output" },
      { label: "For Enterprises", href: "/solutions/enterprise", description: "Governed, scalable deployment" },
      { label: "Customer Support", href: "/solutions/customer-service", description: "Always-on customer help" },
      { label: "Operations", href: "/solutions/operations", description: "Keep processes moving" },
      { label: "Travel and Hospitality", href: "/solutions/travel", description: "Trip planning at scale" },
    ],
  },
  {
    label: "Resources",
    href: "/resources",
    links: [
      { label: "Documentation", href: "/resources/documentation", description: "Guides and references" },
      { label: "Help Centre", href: "/resources/help-centre", description: "Answers to common questions" },
      { label: "Blog", href: "/resources/blog", description: "Ideas on AI employees at work" },
      { label: "Case Studies", href: "/resources/case-studies", description: "Representative use cases" },
      { label: "FAQs", href: "/resources/faq", description: "Frequently asked questions" },
      { label: "Contact", href: "/contact", description: "Talk to our team" },
    ],
  },
];

export const topLevelNav: NavLink[] = [
  { label: "Customers", href: "/customers" },
  { label: "Pricing", href: "/pricing" },
];

export const footerColumns = {
  product: [
    { label: "AI Employees", href: "/meet-ai-employees" },
    { label: "Platform Features", href: "/platform/capabilities" },
    { label: "Use Cases", href: "/customers" },
    { label: "Pricing", href: "/pricing" },
    { label: "Roadmap", href: "/resources/blog" },
    { label: "Book a Demo", href: "/book-demo" },
  ],
  solutions: [
    { label: "By Department", href: "/solutions" },
    { label: "For Enterprises", href: "/solutions/enterprise" },
    { label: "For Start-ups", href: "/solutions/startups" },
    { label: "Travel", href: "/solutions/travel" },
    { label: "Customer Support", href: "/solutions/customer-service" },
    { label: "Security and Governance", href: "/security" },
  ],
  resources: [
    { label: "Documentation", href: "/resources/documentation" },
    { label: "Help Centre", href: "/resources/help-centre" },
    { label: "Blog", href: "/resources/blog" },
    { label: "Case Studies", href: "/resources/case-studies" },
    { label: "Webinars", href: "/resources" },
    { label: "FAQs", href: "/resources/faq" },
  ],
  company: [
    { label: "About Us", href: "/about" },
    { label: "Careers", href: "/about#careers" },
    { label: "Partners", href: "/about#partners" },
    { label: "Press Kit", href: "/about#press" },
    { label: "Newsroom", href: "/resources/blog" },
    { label: "Contact Us", href: "/contact" },
  ],
  legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
    { label: "Data Processing", href: "/security#data-processing" },
    { label: "Security", href: "/security" },
    { label: "Cookie Policy", href: "/cookies" },
  ],
};
