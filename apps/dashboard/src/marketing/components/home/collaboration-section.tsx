import { Handshake } from "lucide-react";
import { ButtonLink } from "@/components/shared/button-link";

export function CollaborationSection() {
  return (
    <section className="bg-white px-4 py-7 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl rounded-modal border border-gold/30 bg-cream/60 p-8 text-center sm:p-10">
        <Handshake className="mx-auto h-9 w-9 text-saffron" aria-hidden="true" />
        <h2 className="mt-5 text-2xl font-bold text-ink sm:text-[32px] lg:text-[38px]">Built to Collaborate With Your Team</h2>
        <p className="mx-auto mt-4 max-w-[600px] text-base leading-relaxed text-muted">
          We work closely with every customer during onboarding to scope AI employees around real workflows,
          connect the right knowledge and systems, and configure approval boundaries that match how your
          organisation operates. AI Workforce OS is built to extend your teams, not replace them.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <ButtonLink href="/contact" variant="primary">
            Talk to Our Team
          </ButtonLink>
          <ButtonLink href="/about" variant="secondary">
            Our Approach
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
