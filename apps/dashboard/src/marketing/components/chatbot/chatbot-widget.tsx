"use client";

import { MessageCircle, X } from "lucide-react";
import { useChatbot } from "./chatbot-provider";
import { ChatbotPanel } from "./chatbot-panel";

export function ChatbotWidget() {
  const { isOpen, isMinimized, open, close } = useChatbot();

  return (
    <>
      {isOpen && !isMinimized && <ChatbotPanel />}

      <button
        type="button"
        onClick={() => (isOpen ? close() : open())}
        aria-label={isOpen ? "Close AI Workforce OS assistant" : "Open AI Workforce OS assistant"}
        aria-expanded={isOpen && !isMinimized}
        className="focus-ring fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-royal text-white shadow-gold ring-4 ring-saffron/20 transition-transform duration-200 hover:scale-105"
      >
        {isOpen ? (
          <X className="h-6 w-6" aria-hidden="true" />
        ) : (
          <MessageCircle className="h-6 w-6 text-gold" aria-hidden="true" />
        )}
      </button>
    </>
  );
}
