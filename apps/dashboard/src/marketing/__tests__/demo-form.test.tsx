// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DemoForm } from "@/components/forms/demo-form";

describe("DemoForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    );
  });

  it("shows validation errors when required fields are empty", () => {
    render(<DemoForm />);
    fireEvent.click(screen.getByRole("button", { name: /book a demo/i }));

    expect(screen.getByText("Please enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Please enter a valid business email.")).toBeInTheDocument();
    expect(screen.getByText("Please enter your company name.")).toBeInTheDocument();
    expect(screen.getByText("Please enter your job title.")).toBeInTheDocument();
    expect(screen.getByText("Please describe your primary use case.")).toBeInTheDocument();
  });

  it("submits and shows a success confirmation when valid", async () => {
    render(<DemoForm />);

    fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Priya Nair" } });
    fireEvent.change(screen.getByLabelText("Business Email"), { target: { value: "priya@example.com" } });
    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Acme Corp" } });
    fireEvent.change(screen.getByLabelText("Job Title"), { target: { value: "Head of Ops" } });
    fireEvent.change(screen.getByLabelText("Primary Use Case"), { target: { value: "Automating travel desk requests" } });

    fireEvent.click(screen.getByRole("button", { name: /book a demo/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Demo request received, Priya.");
    });
    expect(fetch).toHaveBeenCalledWith("/api/demo", expect.objectContaining({ method: "POST" }));
  });
});
