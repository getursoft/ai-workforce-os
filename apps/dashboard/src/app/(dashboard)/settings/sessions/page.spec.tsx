import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionsPage from "./page";

describe("SessionsPage", () => {
  it("renders the unsupported session-management placeholder safely", () => {
    const html = renderToStaticMarkup(createElement(SessionsPage));

    expect(html).toContain("Session management is not supported yet");
    expect(html).toContain("Sprint 1.1 keeps logout");
  });
});
