import { describe, expect, it } from "vitest";
import { InvalidDomainValueError, InvalidEntityStateError } from "../shared/domain.error";
import { OrganizationId } from "./organization-id";
import { OrganizationName } from "./organization-name";
import { OrganizationSlug } from "./organization-slug";
import { OrganizationStatus } from "./organization-status";
import { Organization } from "./organization";

describe("OrganizationName", () => {
  it("requires a trimmed name between 2 and 120 characters", () => {
    expect(OrganizationName.create("  Acme  ").toString()).toBe("Acme");
    expect(() => OrganizationName.create(" ")).toThrow(InvalidDomainValueError);
    expect(() => OrganizationName.create("A")).toThrow(InvalidDomainValueError);
    expect(() => OrganizationName.create("A".repeat(121))).toThrow(InvalidDomainValueError);
  });
});

describe("OrganizationSlug", () => {
  it("accepts lowercase letters, numbers, and internal hyphens", () => {
    expect(OrganizationSlug.create("acme-2").toString()).toBe("acme-2");
  });

  it.each(["Acme", "-acme", "acme-", "acme--team", "acme_team"])(
    "rejects invalid slug %s",
    (slug) => {
      expect(() => OrganizationSlug.create(slug)).toThrow(InvalidDomainValueError);
    }
  );
});

describe("Organization", () => {
  it("creates an active organization", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const organization = Organization.create(
      OrganizationId.from("00000000-0000-4000-8000-000000000001"),
      OrganizationName.create("Acme"),
      OrganizationSlug.create("acme"),
      now
    );

    expect(organization.status).toBe(OrganizationStatus.ACTIVE);
    expect(organization.createdAt).toEqual(now);
    expect(organization.updatedAt).toEqual(now);
  });

  it("rejects invalid reconstruction chronology", () => {
    expect(() =>
      Organization.reconstruct({
        id: OrganizationId.from("00000000-0000-4000-8000-000000000001"),
        name: OrganizationName.create("Acme"),
        slug: OrganizationSlug.create("acme"),
        status: OrganizationStatus.ACTIVE,
        createdAt: new Date("2026-07-10T10:00:00.000Z"),
        updatedAt: new Date("2026-07-10T09:00:00.000Z")
      })
    ).toThrow(InvalidEntityStateError);
  });

  it("rejects invalid persisted identifiers", () => {
    expect(() => OrganizationId.from("organization-1")).toThrow(InvalidDomainValueError);
  });
});
