import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatAction } from "@/lib/chatbot-types";

export function ChatbotActions({ actions }: { actions: ChatAction[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Link
          key={action.href + action.label}
          href={action.href}
          className={cn(
            "focus-ring inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
            action.type === "primary"
              ? "bg-saffron text-white hover:bg-[#d97b00]"
              : "border border-royal/20 text-royal hover:bg-royal/5"
          )}
        >
          {action.label}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}
