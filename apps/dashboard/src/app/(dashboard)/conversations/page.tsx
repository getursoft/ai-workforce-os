import type { Metadata } from "next";
import { ConversationsPage as ConversationsView } from "../../../features/agents/agent-pages";

export const metadata: Metadata = {
  title: "Conversations | Krevia.ai"
};

export default function ConversationsPage() {
  return <ConversationsView />;
}
