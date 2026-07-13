import { ConversationDetail } from "../../../../features/agents/agent-pages";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ConversationDetail id={(await params).id} />;
}
