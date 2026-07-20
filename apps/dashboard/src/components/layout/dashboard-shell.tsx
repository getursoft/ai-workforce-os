"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth, useLogout } from "../../features/auth/auth-provider";
import { buildLoginRedirectPath } from "../../lib/return-url";
import { Avatar, Badge, Button, Card, DropdownMenu, PageHeader, Skeleton } from "../ui";
import { displayName, toggleSidebar } from "./dashboard-shell.logic";
import { useEffectivePermissions } from "../../features/admin/authorization";

const NAV_ITEMS: readonly { href: string; label: string; permission?: string }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/ai-employees", label: "AI Employees", permission: "agents.run" },
  { href: "/dashboard/tasks", label: "Tasks" },
  { href: "/conversations", label: "Conversations", permission: "agents.conversations.read" },
  { href: "/execution-history", label: "Execution History", permission: "agents.executions.read" },
  { href: "/dashboard/knowledge", label: "Knowledge" },
  { href: "/dashboard/integrations", label: "Integrations" },
  { href: "/teams", label: "Teams", permission: "TEAM_READ" },
  { href: "/dashboard/organization", label: "Organization" },
  { href: "/dashboard/settings", label: "Settings" }
] as const;

export const ADMIN_ITEMS = [
  { href: "/connectors", label: "Connectors", permission: "connector.read" },
  { href: "/dashboard/plugins", label: "Plugins", permission: "plugin.read" },
  {
    href: "/dashboard/service-accounts",
    label: "Service Accounts",
    permission: "service_accounts.read"
  },
  { href: "/dashboard/settings/users", label: "Users", permission: "users.read" },
  { href: "/dashboard/settings/roles", label: "Roles", permission: "roles.read" },
  { href: "/dashboard/settings/permissions", label: "Permissions", permission: "roles.read" },
  { href: "/dashboard/settings/invitations", label: "Invitations", permission: "invitations.read" }
] as const;

export function adminNavigationItemsFor(permissions: ReadonlySet<string>) {
  return ADMIN_ITEMS.filter((item) => permissions.has(item.permission));
}

export function DashboardShell({
  title,
  description,
  children
}: Readonly<{ title: string; description?: string; children: ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { state } = useAuth();
  const logout = useLogout();
  const [mobileOpen, setMobileOpen] = useState(false);
  const permissions = useEffectivePermissions();

  const currentUserName = useMemo(
    () => displayName(state.user?.firstName, state.user?.lastName),
    [state.user?.firstName, state.user?.lastName]
  );

  useEffect(() => {
    if (state.isInitializing) {
      return;
    }
    if (!state.isAuthenticated) {
      router.replace(
        buildLoginRedirectPath(`${pathname}${search.toString() ? `?${search.toString()}` : ""}`)
      );
    }
  }, [pathname, router, search, state.isAuthenticated, state.isInitializing]);

  if (state.isInitializing) {
    return (
      <main className="dashboard-shell dashboard-shell--loading">
        <section className="dashboard-loading">
          <PageHeader
            eyebrow="AI Workforce OS"
            title="Loading your workspace"
            description="Restoring your authenticated session."
          />
          <div className="dashboard-loading__grid">
            <Skeleton className="dashboard-loading__sidebar" />
            <Skeleton className="dashboard-loading__content" />
          </div>
        </section>
      </main>
    );
  }

  if (!state.isAuthenticated) {
    return null;
  }

  return (
    <div className="dashboard-shell">
      <aside className={`dashboard-sidebar ${mobileOpen ? "dashboard-sidebar--open" : ""}`}>
        <div className="dashboard-sidebar__brand">
          <div>
            <p className="dashboard-sidebar__eyebrow">AI Workforce OS</p>
            <h2>{state.organization?.name ?? "Organization"}</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="dashboard-sidebar__close"
            onClick={() => setMobileOpen((current) => toggleSidebar(current))}
            aria-label="Close navigation"
          >
            ×
          </Button>
        </div>
        <nav aria-label="Primary" className="dashboard-nav">
          {NAV_ITEMS.filter((item) => !item.permission || permissions.has(item.permission)).map(
            (item) => (
              <Link
                key={item.href}
                className={`dashboard-nav__item ${pathname.startsWith(item.href) ? "dashboard-nav__item--active" : ""}`}
                href={item.href}
                onClick={() => setMobileOpen(false)}
              >
                {item.label}
              </Link>
            )
          )}
          {adminNavigationItemsFor(permissions).length ? (
            <p className="dashboard-nav__section">Administration</p>
          ) : null}
          {adminNavigationItemsFor(permissions).map((item) => (
            <Link
              key={item.href}
              className={`dashboard-nav__item ${pathname.startsWith(item.href) ? "dashboard-nav__item--active" : ""}`}
              href={item.href}
              onClick={() => setMobileOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Card className="dashboard-sidebar__status">
          <p className="dashboard-sidebar__label">Status</p>
          <Badge tone="success">{state.organization?.status ?? "ACTIVE"}</Badge>
          <p className="dashboard-sidebar__meta">{currentUserName}</p>
          <p className="dashboard-sidebar__meta">{state.user?.email}</p>
        </Card>
      </aside>

      <div className="dashboard-overlay" onClick={() => setMobileOpen(false)} aria-hidden="true" />

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <Button
            type="button"
            variant="ghost"
            className="dashboard-topbar__menu"
            onClick={() => setMobileOpen((current) => toggleSidebar(current))}
            aria-label="Open navigation"
          >
            ☰
          </Button>
          <PageHeader {...(description ? { title, description } : { title })} />
          <div className="dashboard-topbar__actions">
            <Badge tone="neutral">{state.organization?.name}</Badge>
            <DropdownMenu
              triggerProps={{ "aria-label": "User menu" }}
              trigger={
                <span className="dashboard-user-chip">
                  <Avatar name={currentUserName} />
                  <span>
                    <strong>{currentUserName}</strong>
                    <small>{state.user?.email}</small>
                  </span>
                </span>
              }
            >
              <div className="dashboard-user-menu">
                <Link href="/dashboard/profile">Profile</Link>
                <Link href="/dashboard/settings/sessions">Sessions</Link>
                <Link href="/dashboard/settings">Settings</Link>
                <Button
                  type="button"
                  variant="ghost"
                  className="dashboard-user-menu__logout"
                  onClick={async () => {
                    try {
                      await logout();
                    } finally {
                      router.replace("/login");
                    }
                  }}
                >
                  Logout
                </Button>
              </div>
            </DropdownMenu>
          </div>
        </header>

        <main className="dashboard-content">{children}</main>
      </div>
    </div>
  );
}
