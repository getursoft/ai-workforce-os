import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayName, toggleSidebar } from "./dashboard-shell.logic";
import { adminNavigationItemsFor, DashboardShell } from "./dashboard-shell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn()
  }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams("")
}));

// Mutable so individual tests can render as the platform owner vs a normal Owner/Admin without a second
// vi.mock — see the "Sales Leads navigation visibility" tests below (Platform Owner Sales Leads feature).
let mockIsPlatformOwner = false;
let mockRole: "OWNER" | "ADMIN" | "MEMBER" = "OWNER";

vi.mock("../../features/auth/auth-provider", () => ({
  useAuth: () => ({
    state: {
      user: {
        id: "1",
        organizationId: "1",
        firstName: "Krishna",
        lastName: "Pandey",
        email: "admin@getursoft.com",
        role: mockRole,
        status: "ACTIVE",
        isPlatformOwner: mockIsPlatformOwner
      },
      organization: { id: "1", name: "Getursoft", slug: "getursoft", status: "ACTIVE" },
      accessToken: "token",
      isAuthenticated: true,
      isInitializing: false
    }
  }),
  useLogout: () => vi.fn()
}));

vi.mock("../../features/admin/authorization", () => ({
  useEffectivePermissions: () =>
    new Set([
      "agents.run",
      "agents.conversations.read",
      "agents.executions.read",
      "knowledge.read",
      "users.read",
      "roles.read",
      "invitations.read"
    ])
}));

describe("DashboardShell", () => {
  afterEach(() => {
    mockIsPlatformOwner = false;
    mockRole = "OWNER";
  });

  it("renders the authenticated dashboard shell", () => {
    const html = renderToStaticMarkup(
      <DashboardShell title="Dashboard" description="Overview">
        <div>content</div>
      </DashboardShell>
    );

    expect(html).toContain("Getursoft");
    expect(html).toContain("Krishna Pandey");
    expect(html).toContain("Dashboard");
    expect(html).toContain("AI Employees");
    expect(html).toContain("Knowledge Base");
    expect(html).toContain("Settings");
  });

  it("formats names and toggles sidebar state in helpers", () => {
    expect(displayName("Krishna", "Pandey")).toBe("Krishna Pandey");
    expect(displayName(undefined, undefined)).toBe("Account");
    expect(toggleSidebar(true)).toBe(false);
    expect(toggleSidebar(false)).toBe(true);
  });

  it("shows every administration destination for Owner permissions", () => {
    const items = adminNavigationItemsFor(
      new Set(["users.read", "roles.read", "invitations.read"])
    );
    expect(items.map(({ label }) => label)).toEqual([
      "Users",
      "Roles",
      "Permissions",
      "Invitations"
    ]);
  });

  // Platform Owner Sales Leads feature: navigation visibility must be role/permission-based
  // (state.user?.isPlatformOwner, the same flag PlatformOwnerGuard/PlatformOwnerGate already rely on),
  // never a hardcoded email — see dashboard-shell.tsx's nav block right after the Organizations link.
  it("shows Sales Leads navigation only for the platform owner", () => {
    mockIsPlatformOwner = true;
    const html = renderToStaticMarkup(
      <DashboardShell title="Dashboard" description="Overview">
        <div>content</div>
      </DashboardShell>
    );
    expect(html).toContain("Sales Leads");
    expect(html).toContain("/dashboard/sales-leads");
  });

  it("hides Sales Leads navigation for a normal organization Owner", () => {
    mockIsPlatformOwner = false;
    mockRole = "OWNER";
    const html = renderToStaticMarkup(
      <DashboardShell title="Dashboard" description="Overview">
        <div>content</div>
      </DashboardShell>
    );
    expect(html).not.toContain("Sales Leads");
  });

  it("hides Sales Leads navigation for a normal organization Admin", () => {
    mockIsPlatformOwner = false;
    mockRole = "ADMIN";
    const html = renderToStaticMarkup(
      <DashboardShell title="Dashboard" description="Overview">
        <div>content</div>
      </DashboardShell>
    );
    expect(html).not.toContain("Sales Leads");
  });
});
