// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatbotProvider } from "@/components/chatbot/chatbot-provider";
import { ChatbotWidget } from "@/components/chatbot/chatbot-widget";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

function renderWidget() {
  return render(
    <ChatbotProvider>
      <ChatbotWidget />
    </ChatbotProvider>
  );
}

describe("Chatbot", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: "Here is an answer.", actions: [] }),
      })
    );
  });

  it("opens the panel when the floating button is clicked", () => {
    renderWidget();
    fireEvent.click(screen.getByLabelText("Open Krevia.ai assistant"));
    expect(screen.getByRole("dialog", { name: /Krevia.ai assistant/i })).toBeInTheDocument();
  });

  it("closes the panel when closed again", () => {
    renderWidget();
    fireEvent.click(screen.getByLabelText("Open Krevia.ai assistant"));
    fireEvent.click(screen.getByLabelText("Close Krevia.ai assistant"));
    expect(screen.queryByRole("dialog", { name: /Krevia.ai assistant/i })).not.toBeInTheDocument();
  });

  it("shows the page-aware greeting and suggested prompts", () => {
    renderWidget();
    fireEvent.click(screen.getByLabelText("Open Krevia.ai assistant"));
    expect(screen.getByText(/here to help you explore Krevia.ai/i)).toBeInTheDocument();
    expect(screen.getByText("What is an AI employee?")).toBeInTheDocument();
  });

  it("sends a suggested prompt and displays the assistant's reply", async () => {
    renderWidget();
    fireEvent.click(screen.getByLabelText("Open Krevia.ai assistant"));
    fireEvent.click(screen.getByText("What is an AI employee?"));

    await waitFor(() => {
      expect(screen.getByText("Here is an answer.")).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith("/api/public-chat", expect.objectContaining({ method: "POST" }));
  });

  it("shows a fallback message when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    renderWidget();
    fireEvent.click(screen.getByLabelText("Open Krevia.ai assistant"));
    fireEvent.click(screen.getByText("What is an AI employee?"));

    await waitFor(() => {
      expect(
        screen.getByText(/I do not have a confirmed answer for that yet/i)
      ).toBeInTheDocument();
    });
  });
});
