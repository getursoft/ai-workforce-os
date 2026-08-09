import type { Metadata } from "next";
import { EmployeesPage } from "../../../features/agents/agent-pages";

export const metadata: Metadata = {
  title: "AI Employees | Krevia.ai"
};

export default function AiEmployeesPage() {
  return <EmployeesPage />;
}
