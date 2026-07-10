import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { displayName, toggleSidebar } from "./dashboard-shell.logic";
import { DashboardShell } from "./dashboard-shell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn()
  }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams("")
}));

vi.mock("../../features/auth/auth-provider", () => ({
  useAuth: () => ({
    state: {
      user: {
        id: "1",
        organizationId: "1",
        firstName: "Krishna",
        lastName: "Pandey",
        email: "admin@getursoft.com",
        role: "OWNER",
        status: "ACTIVE"
      },
      organization: { id: "1", name: "Getursoft", slug: "getursoft", status: "ACTIVE" },
      accessToken: "token",
      isAuthenticated: true,
      isInitializing: false
    }
  }),
  useLogout: () => vi.fn()
}));

describe("DashboardShell", () => {
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
    expect(html).toContain("Settings");
  });

  it("formats names and toggles sidebar state in helpers", () => {
    expect(displayName("Krishna", "Pandey")).toBe("Krishna Pandey");
    expect(displayName(undefined, undefined)).toBe("Account");
    expect(toggleSidebar(true)).toBe(false);
    expect(toggleSidebar(false)).toBe(true);
  });
});
