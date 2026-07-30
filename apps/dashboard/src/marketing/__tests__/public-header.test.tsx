// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicHeader } from "@/components/layout/public-header";
import { AuthProvider } from "../../features/auth/auth-provider";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// PublicHeader reads auth state (to show Login vs. a Profile menu) via AuthProvider, which every real
// page gets from the root layout — tests need the same wrapper. AuthProvider's own session bootstrap
// call has no server to reach in this environment, so it settles to "not authenticated", matching every
// assertion below (all written for a logged-out visitor).
function renderHeader(ui: ReactElement = <PublicHeader />) {
  return render(<AuthProvider>{ui}</AuthProvider>);
}

describe("PublicHeader", () => {
  it("renders the primary navigation labels", async () => {
    renderHeader();
    await waitFor(() => expect(screen.getByText("Log in")).toBeInTheDocument());
    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("AI Employees")).toBeInTheDocument();
    expect(screen.getByText("Solutions")).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByText("Customers")).toBeInTheDocument();
    expect(screen.getByText("Pricing")).toBeInTheDocument();
  });

  it("shows Login and Book a Demo actions", async () => {
    renderHeader();
    await waitFor(() => expect(screen.getByText("Log in")).toBeInTheDocument());
    expect(screen.getByText("Book a Demo")).toBeInTheDocument();
  });

  it("opens a dropdown menu revealing its links", async () => {
    renderHeader();
    await waitFor(() => expect(screen.getByText("Log in")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Platform/i }));
    expect(screen.getByText("Knowledge and Memory")).toBeInTheDocument();
  });

  it("opens the mobile navigation drawer", async () => {
    renderHeader();
    await waitFor(() => expect(screen.getByText("Log in")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Open menu"));
    expect(screen.getByRole("dialog", { name: /mobile navigation/i })).toBeInTheDocument();
  });
});
