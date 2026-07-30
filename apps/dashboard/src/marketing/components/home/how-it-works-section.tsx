import { SectionHeading } from "@/components/shared/section-heading";

const steps = [
  {
    step: "01",
    title: "Choose Your AI Employees",
    description: "Select from Travel, HR, Finance, IT Support, Sales, Marketing or a Custom AI Employee built around your workflow.",
  },
  {
    step: "02",
    title: "Connect Knowledge and Tools",
    description: "Ground each AI employee in your documents, policies and systems, and grant access to the tools it needs.",
  },
  {
    step: "03",
    title: "Configure Approvals",
    description: "Set the approval rules that decide which actions run automatically and which need a human sign-off.",
  },
  {
    step: "04",
    title: "Deploy and Collaborate",
    description: "AI employees go live across your chosen channels, working alongside your teams from day one.",
  },
  {
    step: "05",
    title: "Monitor and Improve",
    description: "Track usage, outcomes and trends through analytics, and refine scope as adoption grows.",
  },
];

export function HowItWorksSection() {
  return (
    <section className="bg-[#FFF9F2] py-9">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Getting started" title="How It Works" description="From selection to deployment in five clear steps." />
        <div className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((item) => (
            <div key={item.step} className="relative rounded-card border border-royal/10 bg-ivory/60 p-6">
              <span className="font-display text-3xl font-bold text-saffron/30">{item.step}</span>
              <h3 className="mt-3 text-base font-semibold text-ink">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
