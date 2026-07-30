// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PublicFooter } from "@/components/layout/public-footer";
import { footerColumns } from "@/content/navigation";

describe("PublicFooter", () => {
  it("renders every footer link with a real, non-empty href", () => {
    render(<PublicFooter />);

    const allLinks = Object.values(footerColumns).flat();
    for (const link of allLinks) {
      const anchor = screen.getByRole("link", { name: link.label });
      expect(anchor).toHaveAttribute("href", link.href);
      expect(link.href.length).toBeGreaterThan(0);
    }
  });

  it("renders the brand name and tagline", () => {
    render(<PublicFooter />);
    expect(screen.getAllByText("AI Workforce OS").length).toBeGreaterThan(0);
    expect(screen.getByText("The Operating System for AI Employees")).toBeInTheDocument();
  });

  it("renders the newsletter form", () => {
    render(<PublicFooter />);
    expect(screen.getByPlaceholderText("Enter your email")).toBeInTheDocument();
  });
});
