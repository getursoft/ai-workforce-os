import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { siteConfig } from "@/content/site";
import { HeroSection } from "@/components/home/hero-section";
import { AiEmployeeGrid } from "@/components/home/ai-employee-grid";
import { DifferentiatorSection } from "@/components/home/differentiator-section";
import { CapabilitiesSection } from "@/components/home/capabilities-section";
import { HowItWorksSection } from "@/components/home/how-it-works-section";
import { OutcomesSection } from "@/components/home/outcomes-section";
import { IntegrationSection } from "@/components/home/integration-section";
import { SecuritySection } from "@/components/home/security-section";
import { CollaborationSection } from "@/components/home/collaboration-section";
import { TestimonialsSection } from "@/components/home/testimonials-section";
import { FinalCta } from "@/components/home/final-cta";
import { SectionDivider } from "@/components/shared/section-divider";

export const metadata: Metadata = defaultMetadata({
  title: `${siteConfig.name} — ${siteConfig.tagline}`,
  description: siteConfig.description,
  path: "/",
});

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <SectionDivider variant="line" />
      <AiEmployeeGrid />
      <DifferentiatorSection />
      <CapabilitiesSection />
      <SectionDivider variant="mandala" />
      <HowItWorksSection />
      <OutcomesSection />
      <SectionDivider variant="fade" />
      <IntegrationSection />
      <SecuritySection />
      <SectionDivider variant="line" />
      <CollaborationSection />
      <TestimonialsSection />
      <FinalCta />
    </>
  );
}
