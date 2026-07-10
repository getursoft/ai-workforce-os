import { describe, expect, it } from "vitest";
import { IdentityApplicationError } from "../errors/identity.error";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { OrganizationSlug } from "../../domain/organization/organization-slug";
import { uniqueOrganizationSlug } from "./organization-slug";
import { validatePassword } from "./password-policy";

describe("identity application policies", () => {
  it("accepts a strong password and rejects each weak-password category", () => {
    expect(() => validatePassword("StrongPassword@123")).not.toThrow();
    for (const password of [
      "Short@1",
      "lowercaseonly@123",
      "UPPERCASEONLY@123",
      "NoNumber@Password",
      "NoSpecialPassword123"
    ]) {
      expect(() => validatePassword(password)).toThrow(IdentityApplicationError);
    }
  });

  it("generates normalized slugs and deterministic collision suffixes", async () => {
    const occupied = new Set(["getursoft", "getursoft-2"]);
    const repository = {
      existsBySlug: (slug: OrganizationSlug) => Promise.resolve(occupied.has(slug.toString()))
    } as OrganizationRepository;

    await expect(uniqueOrganizationSlug("  Getursoft!!! ", repository)).resolves.toMatchObject({});
    expect((await uniqueOrganizationSlug("Getursoft", repository)).toString()).toBe("getursoft-3");
  });
});
