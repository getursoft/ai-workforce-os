import { describe, expect, it } from "vitest";
import { organizationKeys, shouldRetryOrganizationQuery } from "./use-organization";

describe("organization query hooks", () => {
  it("uses stable cache keys", () => {
    expect(organizationKeys.all).toEqual(["organization"]);
    expect(organizationKeys.settings).toEqual(["organizationSettings"]);
  });

  it("retries once and then stops", () => {
    expect(shouldRetryOrganizationQuery(0)).toBe(true);
    expect(shouldRetryOrganizationQuery(1)).toBe(false);
    expect(shouldRetryOrganizationQuery(2)).toBe(false);
  });
});
