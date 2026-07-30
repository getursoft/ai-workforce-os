export interface PricingFeatureRow {
  feature: string;
  starter: string;
  growth: string;
  enterprise: string;
}

export interface PricingPlan {
  slug: "starter" | "growth" | "enterprise";
  name: string;
  price: string;
  priceNote: string;
  description: string;
  cta: { label: string; href: string };
  highlighted?: boolean;
  features: string[];
}

export const pricingPlans: PricingPlan[] = [
  {
    slug: "starter",
    name: "Starter",
    price: "Contact Sales",
    priceNote: "Ideal for a single team getting started with one AI employee",
    description: "Everything a small team needs to deploy its first AI employee with confidence.",
    cta: { label: "Book a Demo", href: "/book-demo" },
    features: [
      "1 AI employee",
      "Core conversational intelligence",
      "Up to 2 knowledge sources",
      "Standard integrations",
      "Email support",
      "Basic usage reporting",
    ],
  },
  {
    slug: "growth",
    name: "Growth",
    price: "Contact Sales",
    priceNote: "For growing organisations scaling across departments",
    description: "Deploy multiple AI employees with expanded knowledge, integrations and reporting.",
    cta: { label: "Book a Demo", href: "/book-demo" },
    highlighted: true,
    features: [
      "Up to 5 AI employees",
      "Advanced knowledge and memory",
      "Expanded integration library",
      "Human approval workflows",
      "Priority support",
      "Departmental analytics dashboards",
    ],
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    price: "Contact Sales",
    priceNote: "For multi-department and multi-tenant organisations",
    description: "Governed, scalable deployment across your entire organisation with dedicated support.",
    cta: { label: "Contact Sales", href: "/contact" },
    features: [
      "Unlimited AI employees",
      "Custom AI employee configuration",
      "Full integration and API access",
      "Advanced governance and audit controls",
      "Dedicated onboarding and support",
      "Custom security review process",
    ],
  },
];

export const pricingComparison: PricingFeatureRow[] = [
  { feature: "AI employees", starter: "1", growth: "Up to 5", enterprise: "Unlimited" },
  { feature: "Conversations", starter: "Standard volume", growth: "Expanded volume", enterprise: "Custom volume" },
  { feature: "Knowledge sources", starter: "Up to 2", growth: "Up to 10", enterprise: "Unlimited" },
  { feature: "Integrations", starter: "Standard", growth: "Expanded", enterprise: "Full + custom" },
  { feature: "Analytics", starter: "Basic", growth: "Departmental", enterprise: "Organisation-wide" },
  { feature: "Human approvals", starter: "Basic workflow", growth: "Configurable workflow", enterprise: "Advanced governance" },
  { feature: "Support", starter: "Email", growth: "Priority", enterprise: "Dedicated" },
  { feature: "Customisation", starter: "Limited", growth: "Moderate", enterprise: "Extensive" },
  { feature: "Security controls", starter: "Standard", growth: "Enhanced", enterprise: "Enterprise governance" },
];
