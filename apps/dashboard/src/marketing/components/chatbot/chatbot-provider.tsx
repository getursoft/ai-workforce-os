"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { pageContext, defaultPageContext } from "@/content/chatbot-knowledge";
import { chatbotConfig } from "@/lib/chatbot-config";
import { FALLBACK_ANSWER } from "@/content/chatbot-knowledge";
import type { ChatMessage, PublicChatResponse } from "@/lib/chatbot-types";

interface ChatbotContextValue {
  isOpen: boolean;
  isMinimized: boolean;
  isLoading: boolean;
  messages: ChatMessage[];
  greeting: string;
  suggestedPrompts: string[];
  open: () => void;
  close: () => void;
  toggleMinimize: () => void;
  sendMessage: (text: string) => Promise<void>;
  resetConversation: () => void;
}

const ChatbotContext = createContext<ChatbotContextValue | null>(null);

function createId() {
  return Math.random().toString(36).slice(2, 10);
}

function getContextForPath(pathname: string) {
  const direct = pageContext[pathname];
  if (direct) return direct;
  const match = Object.keys(pageContext)
    .filter((key) => key !== "/" && pathname.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return (match !== undefined ? pageContext[match] : undefined) ?? defaultPageContext;
}

export function ChatbotProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const context = getContextForPath(pathname);

  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const open = useCallback(() => {
    setIsOpen(true);
    setIsMinimized(false);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);
  const toggleMinimize = useCallback(() => setIsMinimized((value) => !value), []);

  const resetConversation = useCallback(() => setMessages([]), []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMessage: ChatMessage = { id: createId(), role: "user", content: trimmed };
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      try {
        const response = await fetch(chatbotConfig.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, history, pathname }),
        });

        if (!response.ok) throw new Error("Request failed");

        const data: PublicChatResponse = await response.json();

        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: data.message,
            actions: data.actions,
            relatedQuestions: data.relatedQuestions,
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: FALLBACK_ANSWER,
            isError: true,
            actions: [{ label: "Contact Us", href: "/contact", type: "secondary" }],
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, pathname]
  );

  const value = useMemo<ChatbotContextValue>(
    () => ({
      isOpen,
      isMinimized,
      isLoading,
      messages,
      greeting: context.greeting,
      suggestedPrompts: context.suggestedPrompts,
      open,
      close,
      toggleMinimize,
      sendMessage,
      resetConversation,
    }),
    [isOpen, isMinimized, isLoading, messages, context, open, close, toggleMinimize, sendMessage, resetConversation]
  );

  return <ChatbotContext.Provider value={value}>{children}</ChatbotContext.Provider>;
}

export function useChatbot() {
  const context = useContext(ChatbotContext);
  if (!context) {
    throw new Error("useChatbot must be used within a ChatbotProvider");
  }
  return context;
}
