import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { firstNameOrEmail, relativeTime, toneForExecutionStatus } from "./dashboard-home.logic";
import { DashboardHome } from "./dashboard-home";

const NEVER_RESOLVES = new Promise(() => {});

vi.mock("../../features/auth/auth-provider", () => ({
  useAuth: () => ({
    client: { request: () => NEVER_RESOLVES }
  }),
  useCurrentUser: () => ({
    user: {
      id: "1",
      organizationId: "1",
      firstName: "Krishna",
      lastName: "Pandey",
      email: "admin@getursoft.com",
      role: "OWNER",
      status: "ACTIVE"
    },
    organization: { id: "1", name: "Getursoft", slug: "getursoft", status: "ACTIVE" }
  })
}));

function renderDashboardHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardHome))
  );
}

describe("DashboardHome", () => {
  it("renders the dashboard overview copy — real metrics only, no stale employee-count placeholders", () => {
    const html = renderDashboardHome();

    expect(html).toContain("Welcome back, Krishna");
    expect(html).toContain("Total Conversations");
    expect(html).toContain("AI Executions");
    expect(html).toContain("Credits Used");
    expect(html).toContain("Pending Approvals");
    // The old Sprint-1 placeholder stats must be gone.
    expect(html).not.toContain("Active Tasks");
    expect(html).not.toContain("Pending Actions");
  });

  it("prefers the real first name and falls back to the email prefix", () => {
    expect(firstNameOrEmail("Krishna", "admin@getursoft.com")).toBe("Krishna");
    expect(firstNameOrEmail(null, "admin@getursoft.com")).toBe("admin");
    expect(firstNameOrEmail(null, undefined)).toBe("there");
  });

  it("formats relative time coarsely, never a fabricated precision", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    expect(relativeTime("2026-07-31T11:58:00.000Z", now)).toBe("2m ago");
    expect(relativeTime("2026-07-31T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-28T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("maps execution status to a sensible badge tone", () => {
    expect(toneForExecutionStatus("COMPLETED")).toBe("success");
    expect(toneForExecutionStatus("FAILED")).toBe("danger");
    expect(toneForExecutionStatus("RUNNING")).toBe("warning");
    expect(toneForExecutionStatus("QUEUED")).toBe("warning");
  });
});
