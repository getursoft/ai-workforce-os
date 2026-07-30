import { cn } from "@/lib/utils";

interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  size?: "primary" | "secondary";
  className?: string;
}

const titleSizes = {
  primary: "text-3xl font-bold tracking-tight text-ink sm:text-4xl lg:text-[44px]",
  secondary: "text-2xl font-bold tracking-tight text-ink sm:text-[32px] lg:text-[38px]",
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  size = "primary",
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-[760px] text-center" : "max-w-[760px]", className)}>
      {eyebrow && (
        <div
          className={cn(
            "mb-3 flex items-center gap-3 text-saffron",
            align === "center" && "justify-center"
          )}
        >
          <span className="h-px w-8 bg-gold/60" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em]">{eyebrow}</span>
          <span className="h-px w-8 bg-gold/60" aria-hidden="true" />
        </div>
      )}
      <h2 className={titleSizes[size]}>{title}</h2>
      {description && <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">{description}</p>}
    </div>
  );
}
