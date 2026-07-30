import type { Metadata } from "next";
import { FileSearch, BrainCircuit, History, ShieldAlert, FolderKanban, RefreshCw } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Knowledge and Memory",
  description:
    "See how AI Workforce OS grounds AI employees in your organisation's documents and systems, and how memory keeps context relevant over time.",
  path: "/platform/knowledge",
});

const knowledgeFeatures = [
  { icon: FolderKanban, title: "Connected Knowledge Sources", description: "Bring in documents, policies, wikis and structured data as sources of truth." },
  { icon: FileSearch, title: "Grounded Answers", description: "Responses reference your organisation's real content rather than general assumptions." },
  { icon: ShieldAlert, title: "Confirmed Answers Only", description: "When a confirmed answer is not available, AI employees say so instead of guessing." },
  { icon: RefreshCw, title: "Keeps Pace with Change", description: "Knowledge sources can be updated as your policies and documents evolve." },
];

const memoryFeatures = [
  { icon: BrainCircuit, title: "Contextual Memory", description: "Recalls relevant details from earlier in a conversation or previous interactions." },
  { icon: History, title: "Preference Retention", description: "Remembers stated preferences so repeat interactions feel continuous, not repetitive." },
];

export default function KnowledgePage() {
  return (
    <>
      <PageHero
        eyebrow="Knowledge and memory"
        title="Grounded in Your Organisation, Not Generic Assumptions"
        description="AI employees answer using your documents, policies and systems — and remember relevant context so every interaction builds on the last."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Organisational knowledge" title="How Knowledge Grounding Works" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {knowledgeFeatures.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Memory" title="Why Memory Matters" />
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {memoryFeatures.map((item) => (
              <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
            ))}
          </div>
          <div className="mt-8 rounded-card border border-gold/30 bg-cream/60 p-6 text-center">
            <p className="text-sm leading-relaxed text-ink/80">
              Memory is scoped to what is relevant and permitted, and can be corrected or reset by authorised
              administrators.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-9 text-center sm:px-6 lg:px-8">
        <SectionHeading title="Ready to connect your organisation's knowledge?" />
        <div className="mt-8">
          <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
        </div>
      </section>
    </>
  );
}
