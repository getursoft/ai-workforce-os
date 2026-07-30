"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, X, Minus, RotateCcw, Bot } from "lucide-react";
import { useChatbot } from "./chatbot-provider";
import { ChatMessage } from "./chat-message";
import { SuggestedPrompts } from "./suggested-prompts";

export function ChatbotPanel() {
  const { messages, greeting, suggestedPrompts, isLoading, close, toggleMinimize, sendMessage, resetConversation } =
    useChatbot();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isLoading]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.trim()) return;
    sendMessage(input);
    setInput("");
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="AI Workforce OS assistant"
      className="fixed inset-x-4 bottom-4 z-50 flex h-[70vh] max-h-[600px] flex-col overflow-hidden rounded-card border border-royal/10 bg-white shadow-card sm:inset-x-auto sm:bottom-24 sm:right-6 sm:w-96"
    >
      <div className="flex items-center justify-between bg-royal px-4 py-3.5">
        <div className="flex items-center gap-2.5 text-white">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-saffron/20 text-gold">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">AI Workforce OS Assistant</p>
            <p className="text-[11px] text-white/60">Usually replies instantly</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={resetConversation}
            aria-label="Reset conversation"
            title="Reset conversation"
            className="focus-ring rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleMinimize}
            aria-label="Minimise chat"
            title="Minimise"
            className="focus-ring rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close chat"
            title="Close"
            className="focus-ring rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <ChatMessage message={{ id: "greeting", role: "assistant", content: greeting }} />

        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 pl-10 text-xs text-muted" role="status" aria-live="polite">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-saffron [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-saffron [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-saffron" />
            </span>
            Assistant is typing
          </div>
        )}

        {messages.length === 0 && !isLoading && (
          <SuggestedPrompts prompts={suggestedPrompts} onSelect={(prompt) => sendMessage(prompt)} />
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-royal/10 p-3">
        <label htmlFor="chatbot-input" className="sr-only">
          Type your message
        </label>
        <input
          id="chatbot-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about AI employees, pricing, security…"
          className="focus-ring w-full rounded-full border border-royal/15 px-4 py-2 text-sm text-ink placeholder:text-muted/70"
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          aria-label="Send message"
          className="focus-ring flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-saffron text-white transition-colors hover:bg-[#d97b00] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
