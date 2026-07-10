import type { Metadata } from "next";
import { PlaceholderPage } from "../../../components/dashboard/placeholder-page";

export const metadata: Metadata = {
  title: "Tasks | AI Workforce OS"
};

export default function TasksPage() {
  return <PlaceholderPage title="Tasks" description="Task orchestration lands after Sprint 1.1." />;
}
