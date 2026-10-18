import type { Metadata } from "next";
import { CreateJobPage } from "../../../../../../features/recruitment/recruitment-pages";

export const metadata: Metadata = { title: "Create Job | Krevia.ai" };

export default function Page() {
  return <CreateJobPage />;
}
