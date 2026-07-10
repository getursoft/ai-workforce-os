import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { firstNameOrEmail } from "./dashboard-home.logic";
import { DashboardHome } from "./dashboard-home";

vi.mock("../../features/auth/auth-provider", () => ({
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

describe("DashboardHome", () => {
  it("renders the dashboard overview copy", () => {
    const html = renderToStaticMarkup(createElement(DashboardHome));

    expect(html).toContain("Welcome back, Krishna");
    expect(html).toContain("AI Employees");
    expect(html).toContain("Active Tasks");
    expect(html).toContain("Conversations");
    expect(html).toContain("Pending Actions");
  });

  it("prefers the real first name and falls back to the email prefix", () => {
    expect(firstNameOrEmail("Krishna", "admin@getursoft.com")).toBe("Krishna");
    expect(firstNameOrEmail(null, "admin@getursoft.com")).toBe("admin");
    expect(firstNameOrEmail(null, undefined)).toBe("there");
  });
});
