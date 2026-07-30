import type { Metadata } from "next";
import {
  MessagesSquare,
  BookOpenCheck,
  Wrench,
  ListTree,
  BrainCircuit,
  ShieldCheck,
  Users2,
  BarChart4,
  Plug,
  Radio,
} from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { capabilities } from "@/content/capabilities";

export const metadata: Metadata = defaultMetadata({
  title: "Capabilities",
  description:
    "Explore the platform capabilities behind every AI employee: conversational intelligence, knowledge grounding, tool execution, memory, human approval, collaboration and more.",
  path: "/platform/capabilities",
});

const icons = [
  MessagesSquare,
  BookOpenCheck,
  Wrench,
  ListTree,
  BrainCircuit,
  ShieldCheck,
  Users2,
  BarChart4,
  Plug,
  Radio,
];

export default function CapabilitiesPage() {
  return (
    <>
      <PageHero
        eyebrow="Platform capabilities"
        title="What AI Workforce OS Can Do"
        description="Every AI employee is built from the same set of dependable capabilities — grounded, governed and ready to act."
      />
      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-2">
          {capabilities.map((capability, i) => {
            const Icon = icons[i];
            if (!Icon) return null;
            return (
              <div key={capability.slug} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-royal/5 text-royal">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-lg font-bold text-ink">{capability.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{capability.description}</p>
                <ul className="mt-4 space-y-2">
                  {capability.details.map((detail) => (
                    <li key={detail} className="flex gap-2 text-sm text-ink/80">
                      <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-saffron" aria-hidden="true" />
                      {detail}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
