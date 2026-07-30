import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonLinkProps {
  href: string;
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
  showArrow?: boolean;
  target?: string;
  rel?: string;
}

const variantStyles: Record<Variant, string> = {
  primary:
    "bg-royal text-white hover:bg-navy shadow-sm",
  secondary:
    "bg-white text-royal border border-royal/25 hover:border-royal/50 hover:bg-royal/5",
  ghost: "text-royal hover:bg-royal/5",
};

export function ButtonLink({
  href,
  children,
  variant = "primary",
  className,
  showArrow = true,
  target,
  rel,
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      target={target}
      rel={rel}
      className={cn(
        "focus-ring group inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all duration-[220ms] hover:scale-[1.02] active:scale-[0.98]",
        variantStyles[variant],
        className
      )}
    >
      {children}
      {showArrow && (
        <ArrowRight
          className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      )}
    </Link>
  );
}
