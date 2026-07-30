// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContactForm } from "@/components/forms/contact-form";

describe("ContactForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    );
  });

  it("shows validation errors when required fields are empty", () => {
    render(<ContactForm />);
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(screen.getByText("Please enter your name.")).toBeInTheDocument();
    expect(screen.getByText("Please enter a valid business email.")).toBeInTheDocument();
    expect(screen.getByText("Please enter your company name.")).toBeInTheDocument();
    expect(screen.getByText("Please enter a message.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits and shows a success confirmation when valid", async () => {
    render(<ContactForm />);

    fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Asha Rao" } });
    fireEvent.change(screen.getByLabelText("Business Email"), { target: { value: "asha@example.com" } });
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Acme Corp" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Tell me more." } });

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Thank you, Asha.");
    });
    expect(fetch).toHaveBeenCalledWith("/api/contact", expect.objectContaining({ method: "POST" }));
  });
});
