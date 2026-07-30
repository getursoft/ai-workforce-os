import {
  MessagesSquare,
  BookOpenCheck,
  Wrench,
  ListTree,
  BrainCircuit,
  ShieldCheck,
  Users2,
  BarChart4,
} from "lucide-react";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

const icons = [MessagesSquare, BookOpenCheck, Wrench, ListTree, BrainCircuit, ShieldCheck, Users2, BarChart4];

const featured = [
  { title: "Conversational Intelligence", description: "Natural, context-aware conversation that understands business intent." },
  { title: "Knowledge-Grounded Responses", description: "Answers grounded in your documents, policies and systems." },
  { title: "Tool Execution", description: "Calls approved business tools to complete real tasks." },
  { title: "Multi-Step Task Handling", description: "Plans and tracks complex work from a single request." },
  { title: "Memory", description: "Retains relevant preferences and context over time." },
  { title: "Human Approval", description: "Routes sensitive actions to a human before execution." },
  { title: "Collaboration", description: "Works alongside human teams and other AI employees." },
  { title: "Reporting", description: "Clear visibility into activity, usage and outcomes." },
];

export function CapabilitiesSection() {
  return (
    <section className="bg-white px-4 py-9 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Platform"
          title="Core Platform Capabilities"
          description="The building blocks every AI employee is built on."
        />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {featured.map((item, i) => {
            const Icon = icons[i];
            if (!Icon) return null;
            return <FeatureCard key={item.title} icon={Icon} title={item.title} description={item.description} />;
          })}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/platform/capabilities" variant="ghost">
            Explore All Capabilities
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
