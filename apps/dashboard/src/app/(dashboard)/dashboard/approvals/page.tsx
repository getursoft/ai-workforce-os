import type { Metadata } from "next";
import { ApprovalsPage } from "../../../../features/approvals/approval-pages";

export const metadata: Metadata = { title: "Approvals | AI Workforce OS" };

export default function Page() {
  return <ApprovalsPage />;
}
