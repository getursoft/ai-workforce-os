import { Lock, KeyRound, ScrollText, Eye } from "lucide-react";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";

const points = [
  { icon: KeyRound, title: "Role-Based Access", description: "Configurable permissions for every AI employee and user." },
  { icon: Lock, title: "Tenant Isolation", description: "Your organisation's data stays scoped to your organisation." },
  { icon: ScrollText, title: "Audit Logging", description: "A clear record of AI employee actions and approvals." },
  { icon: Eye, title: "Administrative Visibility", description: "Central oversight into activity across departments." },
];

export function SecuritySection() {
  return (
    <section className="bg-[#FFFCF7] py-9">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Enterprise security"
          title="Governed by Design"
          description="AI Workforce OS is designed to support enterprise security requirements with configurable governance controls."
        />
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((item) => (
            <div key={item.title} className="rounded-card border border-royal/10 bg-ivory/60 p-6">
              <item.icon className="h-6 w-6 text-royal" aria-hidden="true" />
              <h3 className="mt-4 font-semibold text-ink">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.description}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/security" variant="ghost">
            Learn About Security
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
