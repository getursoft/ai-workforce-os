import { EmployeeChatPage } from "../../../../features/agents/agent-pages";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <EmployeeChatPage employeeId={(await params).id} />;
}
