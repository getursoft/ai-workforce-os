import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "../components/ui";

export const metadata: Metadata = {
  title: "Page not found | Krevia.ai",
  robots: { index: false, follow: true }
};

export default function NotFound() {
  return (
    <main className="app-screen">
      <EmptyState
        title="Page not found"
        description="The page you requested does not exist."
        action={<Link href="/dashboard">Go to dashboard</Link>}
      />
    </main>
  );
}
