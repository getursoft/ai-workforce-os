import { knowledgeBase, FALLBACK_ANSWER, type KnowledgeEntry } from "@/content/chatbot-knowledge";
import type { PublicChatResponse } from "./chatbot-types";

function score(entry: KnowledgeEntry, normalizedMessage: string): number {
  return entry.keywords.reduce((total, keyword) => {
    return normalizedMessage.includes(keyword.toLowerCase()) ? total + keyword.split(" ").length : total;
  }, 0);
}

export function getLocalResponse(message: string): PublicChatResponse {
  const normalized = message.toLowerCase().trim();

  if (!normalized) {
    return { message: FALLBACK_ANSWER };
  }

  let best: KnowledgeEntry | null = null;
  let bestScore = 0;

  for (const entry of knowledgeBase) {
    const entryScore = score(entry, normalized);
    if (entryScore > bestScore) {
      best = entry;
      bestScore = entryScore;
    }
  }

  if (!best || bestScore === 0) {
    return {
      message: FALLBACK_ANSWER,
      actions: [{ label: "Contact Us", href: "/contact", type: "secondary" }],
    };
  }

  return {
    message: best.answer,
    actions: best.actions,
    relatedQuestions: best.relatedQuestions,
  };
}

export function findActionsForMessage(message: string) {
  return getLocalResponse(message).actions;
}
