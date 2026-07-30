/**
 * Central chatbot runtime configuration. `/api/public-chat` is the only endpoint the
 * browser ever calls; this file just describes how that route should behave and gives
 * later integrators (existing agent API, Azure OpenAI, internal RAG) one place to look.
 */
export const chatbotConfig = {
  apiUrl: process.env.NEXT_PUBLIC_PUBLIC_CHAT_API_URL || "/api/public-chat",
  openRouterModel: "openrouter/free",
  openRouterEndpoint: "https://openrouter.ai/api/v1/chat/completions",
  maxHistoryMessages: 12,
  requestTimeoutMs: 20000,
} as const;

export type ChatProviderMode = "openrouter" | "local";
