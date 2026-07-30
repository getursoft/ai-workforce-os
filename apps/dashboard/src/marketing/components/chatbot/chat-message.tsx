import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage as ChatMessageType } from "@/lib/chatbot-types";
import { ChatbotActions } from "./chatbot-actions";

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-royal text-white" : "bg-saffron/15 text-saffron"
        )}
        aria-hidden="true"
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn("flex max-w-[80%] flex-col gap-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isUser ? "bg-royal text-white" : "bg-cream/70 text-ink",
            message.isError && "border border-saffron/40"
          )}
        >
          {message.content}
        </div>
        {!isUser && message.actions && message.actions.length > 0 && (
          <ChatbotActions actions={message.actions} />
        )}
      </div>
    </div>
  );
}
