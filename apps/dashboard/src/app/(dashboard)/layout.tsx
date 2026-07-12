import type { ReactNode } from "react";
import { DashboardShell } from "../../components/layout/dashboard-shell";
import { PermissionProvider } from "../../features/admin/authorization";

export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PermissionProvider>
      <DashboardShell title="Dashboard" description="Your AI workforce operations center.">
        {children}
      </DashboardShell>
    </PermissionProvider>
  );
}
