import type { Metadata } from "next";
import { WorkforcePage } from "../../../features/workforce/workforce-page";

export const metadata: Metadata = {
  title: "AI Workforce | Krevia.ai"
};

export default function Page() {
  return <WorkforcePage />;
}
