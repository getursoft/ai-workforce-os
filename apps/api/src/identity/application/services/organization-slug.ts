import { identityError } from "../errors/identity.error";
import type { OrganizationRepository } from "../ports/organization-repository";
import { OrganizationSlug } from "../../domain/organization/organization-slug";

const MAX_ATTEMPTS = 100;

export async function uniqueOrganizationSlug(
  name: string,
  repository: OrganizationRepository
): Promise<OrganizationSlug> {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "organization";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = OrganizationSlug.create(`${base.slice(0, 100 - suffix.length)}${suffix}`);
    if (!(await repository.existsBySlug(candidate))) {
      return candidate;
    }
  }
  throw identityError.conflict();
}
