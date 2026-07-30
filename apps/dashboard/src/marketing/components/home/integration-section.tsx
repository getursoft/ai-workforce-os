import { Database, Mail, Calendar, FileText, Cloud, MessageSquare } from "lucide-react";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";

const categories = [
  { icon: Database, label: "CRM" },
  { icon: Mail, label: "Email" },
  { icon: Calendar, label: "Calendar" },
  { icon: FileText, label: "Documents" },
  { icon: Cloud, label: "Cloud Platforms" },
  { icon: MessageSquare, label: "Collaboration Tools" },
];

export function IntegrationSection() {
  return (
    <section className="bg-white px-4 py-7 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Connected"
          title="Integrates with the Systems You Already Use"
          description="AI employees work with your real data — connecting to CRM, email, documents, cloud platforms and more."
          size="secondary"
        />
        <div className="mt-8 grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
          {categories.map((item) => (
            <div
              key={item.label}
              className="flex flex-col items-center gap-3 rounded-card border border-royal/10 bg-[#FFF9F2] p-6 text-center shadow-sm"
            >
              <item.icon className="h-6 w-6 text-royal" aria-hidden="true" />
              <span className="text-sm font-medium text-ink">{item.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/connect" variant="ghost">
            View All Integrations
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
