import type { Metadata } from "next";
import { WorkforcePage } from "../../../features/workforce/workforce-page";

export const metadata: Metadata = {
  title: "AI Workforce | AI Workforce OS"
};

export default function Page() {
  return <WorkforcePage />;
}
