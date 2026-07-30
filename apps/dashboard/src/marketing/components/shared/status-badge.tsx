import { cn } from "@/lib/utils";
import type { IntegrationStatus } from "@/content/integrations";

const statusStyles: Record<IntegrationStatus, string> = {
  Available: "bg-success/10 text-success",
  "In Development": "bg-saffron/10 text-saffron",
  Planned: "bg-royal/10 text-royal",
  "Custom Integration": "bg-gold/15 text-[#8a5a00]",
};

export function StatusBadge({ status }: { status: IntegrationStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold",
        statusStyles[status]
      )}
    >
      {status}
    </span>
  );
}
