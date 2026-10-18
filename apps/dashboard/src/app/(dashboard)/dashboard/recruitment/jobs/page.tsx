import type { Metadata } from "next";
import { RecruitmentJobsPage } from "../../../../../features/recruitment/recruitment-pages";

export const metadata: Metadata = { title: "Job Openings | Krevia.ai" };

export default function Page() {
  return <RecruitmentJobsPage />;
}
