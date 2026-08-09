import { ShieldCheck, Clock, Zap, Lock } from "lucide-react";
import { siteConfig } from "@/content/site";
import { ButtonLink } from "@/components/shared/button-link";
import { DashboardPreview } from "./dashboard-preview";

const trustIcons = [ShieldCheck, Clock, Zap, Lock];

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pb-7 pt-4 sm:pb-9 sm:pt-5 lg:pb-12 lg:pt-7">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:items-start lg:gap-8 lg:px-8">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-saffron/30 bg-white px-4 py-1.5 text-xs font-semibold text-saffron shadow-soft">
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            {siteConfig.tagline}
          </span>

          <h1 className="animate-fade-in-up mt-4 text-4xl font-bold leading-[1.1] tracking-tight text-ink sm:text-5xl lg:text-[56px]">
            {siteConfig.headline.line1}
            <br />
            {siteConfig.headline.line2}
            <br />
            <span className="text-saffron">{siteConfig.headline.line3}</span>
          </h1>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            {siteConfig.supportingText}
          </p>

          <div className="mt-6 flex flex-wrap gap-4">
            <ButtonLink href={siteConfig.heroCtas.primary.href} variant="primary">
              {siteConfig.heroCtas.primary.label}
            </ButtonLink>
            <ButtonLink href={siteConfig.heroCtas.secondary.href} variant="secondary">
              {siteConfig.heroCtas.secondary.label}
            </ButtonLink>
          </div>

          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:grid-cols-2">
            {siteConfig.trustPoints.map((point, i) => {
              const Icon = trustIcons[i];
              if (!Icon) return null;
              return (
                <div key={point.label} className="flex items-start gap-2.5">
                  <Icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-royal" aria-hidden="true" />
                  <div>
                    <dt className="text-sm font-semibold text-ink">{point.label}</dt>
                    <dd className="text-xs text-muted">{point.description}</dd>
                  </div>
                </div>
              );
            })}
          </dl>
        </div>

        <div>
          <DashboardPreview />
          <p className="mt-3 text-center text-xs text-muted">
            Representative preview of the Krevia.ai dashboard using illustrative data.
          </p>
        </div>
      </div>
    </section>
  );
}
