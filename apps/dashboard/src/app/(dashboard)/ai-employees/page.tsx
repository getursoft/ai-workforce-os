import type { Metadata } from "next";
import { PlaceholderPage } from "../../../components/dashboard/placeholder-page";

export const metadata: Metadata = {
  title: "AI Employees | AI Workforce OS"
};

export default function AiEmployeesPage() {
  return (
    <PlaceholderPage
      title="AI Employees"
      description="Create and manage your first AI Employee in a future sprint."
    />
  );
}
