import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  iconClassName?: string;
}

export function FeatureCard({ icon: Icon, title, description, className, iconClassName }: FeatureCardProps) {
  return (
    <div
      className={cn(
        "group rounded-card border border-royal/10 bg-white p-6 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-card",
        className
      )}
    >
      <div
        className={cn(
          "mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-royal/5 text-royal transition-transform duration-300 group-hover:scale-105",
          iconClassName
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
    </div>
  );
}
