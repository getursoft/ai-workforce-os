// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewsletterForm } from "@/components/forms/newsletter-form";

describe("NewsletterForm", () => {
  it("shows a validation error for an invalid email", () => {
    render(<NewsletterForm />);
    const input = screen.getByPlaceholderText("Enter your email");
    fireEvent.change(input, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByLabelText("Subscribe"));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  it("shows a success state for a valid email", () => {
    render(<NewsletterForm />);
    const input = screen.getByPlaceholderText("Enter your email");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByLabelText("Subscribe"));
    expect(screen.getByRole("status")).toHaveTextContent("You're subscribed");
  });
});
