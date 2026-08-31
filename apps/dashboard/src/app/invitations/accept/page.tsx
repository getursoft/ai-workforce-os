import type { Metadata } from "next";
import { InvitationAcceptPage } from "../../../features/admin/admin-ui";
import { defaultMetadata } from "@/lib/seo";

export const metadata: Metadata = defaultMetadata({
  title: "Accept invitation | Krevia.ai",
  description: "Accept your Krevia.ai team invitation.",
  path: "/invitations/accept",
  noIndex: true
});

export default function Page() {
  return <InvitationAcceptPage />;
}
