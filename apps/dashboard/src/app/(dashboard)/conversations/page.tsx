import type { Metadata } from "next";
import { PlaceholderPage } from "../../../components/dashboard/placeholder-page";

export const metadata: Metadata = {
  title: "Conversations | AI Workforce OS"
};

export default function ConversationsPage() {
  return (
    <PlaceholderPage
      title="Conversations"
      description="Conversation tooling is reserved for later sprint work."
    />
  );
}
