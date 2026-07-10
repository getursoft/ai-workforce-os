"use client";

import Link from "next/link";
import { EmptyState, PageHeader } from "../ui";

export function PlaceholderPage({
  title,
  description
}: Readonly<{ title: string; description: string }>) {
  return (
    <div className="dashboard-placeholder">
      <PageHeader eyebrow="Coming later" title={title} description={description} />
      <EmptyState
        title="Coming in a future sprint"
        description="This route is present and safe, but the operational feature is not part of Sprint 1.1."
        action={<Link href="/dashboard">Return to dashboard</Link>}
      />
    </div>
  );
}
