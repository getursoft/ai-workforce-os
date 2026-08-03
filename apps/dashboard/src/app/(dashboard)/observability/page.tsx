import type { Metadata } from "next";
import { ObservabilityPage } from "../../../features/observability/observability-page";

export const metadata: Metadata = {
  title: "Observability | AI Workforce OS"
};

export default function Page() {
  return <ObservabilityPage />;
}
