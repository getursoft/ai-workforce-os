import type { ReactNode } from "react";
import { DashboardShell } from "../../components/layout/dashboard-shell";

export default function DashboardLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <DashboardShell title="Dashboard" description="Your AI workforce operations center.">
      {children}
    </DashboardShell>
  );
}
