export type ChatActionType = "primary" | "secondary";

export interface ChatAction {
  label: string;
  href: string;
  type: ChatActionType;
}

export interface PublicChatResponse {
  message: string;
  actions?: ChatAction[] | undefined;
  relatedQuestions?: string[] | undefined;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  actions?: ChatAction[] | undefined;
  relatedQuestions?: string[] | undefined;
  isError?: boolean;
}
