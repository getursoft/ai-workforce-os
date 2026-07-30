import { cn } from "@/lib/utils";

interface PageHeroProps {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
  className?: string;
}

export function PageHero({ eyebrow, title, description, children, className }: PageHeroProps) {
  return (
    <section className={cn("bg-[#FFF9F2] px-4 pb-7 pt-5 sm:px-6 lg:px-8", className)}>
      <div className="relative mx-auto max-w-4xl overflow-hidden rounded-modal border border-[#E9EDF5] bg-white px-6 py-10 text-center shadow-md sm:px-10 sm:py-12">
        <div className="absolute inset-0 watermark-mandala opacity-[0.04]" aria-hidden="true" />
        <div className="relative">
          <span className="inline-flex items-center rounded-full bg-cream px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-saffron">
            {eyebrow}
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight text-royal sm:text-5xl">{title}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            {description}
          </p>
          {children && <div className="mt-8 flex flex-wrap items-center justify-center gap-4">{children}</div>}
        </div>
      </div>
    </section>
  );
}
