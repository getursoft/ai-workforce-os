import { Briefcase, Users, LineChart, Headset, Target, Megaphone, Sparkles, Scale, LifeBuoy } from "lucide-react";
import type { IconColor } from "@/content/ai-employees";
import { cn } from "@/lib/utils";

const iconColorStyles: Record<IconColor, string> = {
  blue: "bg-[#E3EEFC] text-[#2C5CB0]",
  lavender: "bg-[#EDE7F9] text-[#6B4FA0]",
  mint: "bg-[#E1F5EA] text-[#1E8F58]",
  cyan: "bg-[#E1F6F8] text-[#2389A0]",
  saffron: "bg-[#FDECD2] text-[#C6720A]",
  pink: "bg-[#FBE6EE] text-[#B94E7C]",
};

const slugIcon: Record<string, typeof Briefcase> = {
  travel: Briefcase,
  hr: Users,
  finance: LineChart,
  "it-support": Headset,
  sales: Target,
  marketing: Megaphone,
  legal: Scale,
  "customer-support": LifeBuoy,
  custom: Sparkles,
};

export function EmployeeIcon({
  slug,
  iconColor,
  className = "h-12 w-12",
  iconClassName = "h-1/2 w-1/2",
}: {
  slug: string;
  iconColor: IconColor;
  className?: string;
  iconClassName?: string;
}) {
  const Icon = slugIcon[slug] ?? Sparkles;
  return (
    <div className={cn("flex items-center justify-center rounded-2xl", iconColorStyles[iconColor], className)}>
      <Icon className={iconClassName} aria-hidden="true" />
    </div>
  );
}
