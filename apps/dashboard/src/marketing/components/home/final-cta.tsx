import { Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/shared/button-link";
import { WatermarkPattern } from "@/components/shared/watermark-pattern";

export function FinalCta() {
  return (
    <section className="bg-[#FFFCF7] px-4 py-7 sm:px-6 lg:px-8">
      <div className="relative mx-auto max-w-[1200px] overflow-hidden rounded-modal border border-[#E9EDF5] bg-white px-7 py-10 text-center shadow-[0_10px_30px_rgba(6,43,115,0.06)] sm:px-12 sm:py-14 lg:px-20 lg:py-18">
        <div
          className="pointer-events-none absolute left-1/2 top-0 h-64 w-[640px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-[radial-gradient(circle,rgba(242,140,0,0.08),transparent_70%)] blur-2xl"
          aria-hidden="true"
        />
        <WatermarkPattern
          variant="mandala"
          className="pointer-events-none absolute -left-16 -top-16 h-64 w-64 text-royal opacity-[0.04]"
        />
        <WatermarkPattern
          variant="network"
          className="pointer-events-none absolute -bottom-12 -right-12 h-64 w-64 text-saffron opacity-[0.04]"
        />

        <div className="relative mx-auto flex max-w-[680px] flex-col items-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-cream">
            <Sparkles className="h-5 w-5 text-saffron" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-[30px] font-extrabold leading-tight text-royal sm:text-[42px]">
            Ready to put AI employees to work?
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            See how Krevia.ai can be configured around your organisation in a guided, no-pressure demo.
          </p>
          <div className="mt-8 flex w-full flex-col justify-center gap-4 sm:w-auto sm:flex-row">
            <ButtonLink href="/book-demo" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
              Book a Demo
            </ButtonLink>
            <ButtonLink href="/platform" variant="secondary">
              Explore Platform
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
