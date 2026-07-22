import type { ReactNode } from "react";
import { DashboardShell } from "../../components/layout/dashboard-shell";
import { WorkspaceErrorBoundary } from "../../components/layout/workspace-error-boundary";
import { PermissionProvider } from "../../features/admin/authorization";

export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <WorkspaceErrorBoundary>
      <PermissionProvider>
        <DashboardShell title="Dashboard" description="Your AI workforce operations center.">
          {children}
        </DashboardShell>
      </PermissionProvider>
    </WorkspaceErrorBoundary>
  );
}
