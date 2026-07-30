import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, LifeBuoy, Newspaper, FileSearch, HelpCircle, ArrowRight } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";

export const metadata: Metadata = defaultMetadata({
  title: "Resources",
  description: "Documentation, help centre, blog, case studies and FAQs for AI Workforce OS.",
  path: "/resources",
});

const resources = [
  { icon: BookOpen, title: "Documentation", description: "Guides for configuring AI employees, knowledge, integrations and governance.", href: "/resources/documentation" },
  { icon: LifeBuoy, title: "Help Centre", description: "Answers to common account, billing and platform questions.", href: "/resources/help-centre" },
  { icon: Newspaper, title: "Blog", description: "Perspectives on AI employees, governance and how teams put them to work.", href: "/resources/blog" },
  { icon: FileSearch, title: "Case Studies", description: "Representative scenarios showing AI employees in action.", href: "/resources/case-studies" },
  { icon: HelpCircle, title: "FAQs", description: "Frequently asked questions about the platform.", href: "/resources/faq" },
  { icon: Newspaper, title: "Contact", description: "Get in touch with our team directly.", href: "/contact" },
];

export default function ResourcesPage() {
  return (
    <>
      <PageHero
        eyebrow="Resources"
        title="Everything You Need to Get the Most from AI Workforce OS"
        description="Documentation, guidance and real-world scenarios to help you plan, deploy and scale AI employees."
      />
      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="focus-ring group flex flex-col rounded-card border border-royal/10 bg-white p-6 shadow-soft transition-all hover:-translate-y-1 hover:shadow-card"
            >
              <item.icon className="h-7 w-7 text-royal" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-bold text-ink">{item.title}</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{item.description}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-saffron">
                Explore <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
