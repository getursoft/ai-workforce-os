import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./profile-page";

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

describe("ProfilePage", () => {
  it("renders the authenticated user and organization data", () => {
    const html = renderToStaticMarkup(createElement(ProfilePage));

    expect(html).toContain("Krishna Pandey");
    expect(html).toContain("admin@getursoft.com");
    expect(html).toContain("Getursoft");
    expect(html).toContain("OWNER");
  });
});
