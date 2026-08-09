import type { Metadata } from "next";
import { PlaceholderPage } from "../../../components/dashboard/placeholder-page";

export const metadata: Metadata = {
  title: "Team | Krevia.ai"
};

export default function TeamPage() {
  return <PlaceholderPage title="Team" description="Team management is not part of Sprint 1.1." />;
}
