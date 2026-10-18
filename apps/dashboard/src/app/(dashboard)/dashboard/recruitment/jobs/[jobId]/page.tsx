import type { Metadata } from "next";
import { JobDetailPage } from "../../../../../../features/recruitment/recruitment-pages";

export const metadata: Metadata = { title: "Job Details | Krevia.ai" };

export default function Page() {
  return <JobDetailPage />;
}
