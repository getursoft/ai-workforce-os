import type { Metadata } from "next";
import { ReceptionistEntryPage } from "../../../features/agents/agent-pages";

export const metadata: Metadata = {
  title: "Ask Krevia | Krevia.ai"
};

export default function AskKreviaPage() {
  return <ReceptionistEntryPage />;
}
