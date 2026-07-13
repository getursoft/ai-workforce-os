import type { Metadata } from "next";
import { ConversationsPage as ConversationsView } from "../../../features/agents/agent-pages";

export const metadata: Metadata = {
  title: "Conversations | AI Workforce OS"
};

export default function ConversationsPage() {
  return <ConversationsView />;
}
