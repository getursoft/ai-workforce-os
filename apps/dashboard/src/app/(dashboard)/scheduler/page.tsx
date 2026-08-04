import type { Metadata } from "next";
import { SchedulerPage } from "../../../features/scheduler/scheduler-page";

export const metadata: Metadata = {
  title: "Autonomous Scheduler | AI Workforce OS"
};

export default function Page() {
  return <SchedulerPage />;
}
