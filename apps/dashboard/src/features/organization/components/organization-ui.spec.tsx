import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api-error";
import {
  friendlyOrganizationError,
  LoadingSkeleton,
  OrganizationEmptyState,
  StatusBadge
} from "./organization-ui";
import { organizationSchema } from "./organization-card";
import { settingsSchema } from "./organization-settings-card";

describe("organization UI", () => {
  it("renders loading, empty, and success status states", () => {
    expect(renderToStaticMarkup(createElement(LoadingSkeleton))).toContain("Loading organization");
    expect(
      renderToStaticMarkup(createElement(OrganizationEmptyState, { onRetry: vi.fn() }))
    ).toContain("Retry");
    expect(renderToStaticMarkup(createElement(StatusBadge, { status: "ACTIVE" }))).toContain(
      "ACTIVE"
    );
  });

  it("validates organization and settings forms", () => {
    expect(organizationSchema.safeParse({ name: "ab" }).success).toBe(false);
    expect(organizationSchema.safeParse({ name: "Acme Labs" }).success).toBe(true);
    expect(
      settingsSchema.safeParse({ timezone: "UTC", locale: "en-US", currency: "US" }).success
    ).toBe(false);
  });

  it("shows friendly unauthorized, forbidden, validation, and server errors", () => {
    expect(
      friendlyOrganizationError(
        new ApiError({ kind: "authentication", code: "A", message: "x", status: 401 })
      )
    ).toContain("expired");
    expect(
      friendlyOrganizationError(
        new ApiError({ kind: "authorization", code: "F", message: "x", status: 403 })
      )
    ).toContain("permission");
    expect(
      friendlyOrganizationError(
        new ApiError({
          kind: "validation",
          code: "V",
          message: "Invalid",
          status: 422,
          details: ["Name is invalid"]
        })
      )
    ).toBe("Name is invalid");
    expect(
      friendlyOrganizationError(
        new ApiError({ kind: "server", code: "S", message: "x", status: 500 })
      )
    ).toContain("temporarily unavailable");
  });
});
