import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceErrorFallback } from "./workspace-error-boundary";

describe("WorkspaceErrorBoundary", () => {
  it("offers reload and login recovery actions", () => {
    const html = renderToStaticMarkup(<WorkspaceErrorFallback />);
    expect(html).toContain("Workspace could not be loaded");
    expect(html).toContain("Reload");
    expect(html).toContain("Return to login");
  });
});
