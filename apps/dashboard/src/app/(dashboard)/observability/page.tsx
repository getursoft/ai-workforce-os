import type { Metadata } from "next";
import { ObservabilityPage } from "../../../features/observability/observability-page";

export const metadata: Metadata = {
  title: "Observability | Krevia.ai"
};

export default function Page() {
  return <ObservabilityPage />;
}
