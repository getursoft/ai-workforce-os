import { ExecutionDetail } from "../../../../features/agents/agent-pages";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ExecutionDetail id={(await params).id} />;
}
