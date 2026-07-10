import { InvalidDomainValueError } from "../shared/domain.error";
import { requireNonBlank } from "../shared/validation";

const VALID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class OrganizationSlug {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static create(value: string): OrganizationSlug {
    const normalized = requireNonBlank(value, "organizationSlug");
    if (!VALID_SLUG.test(normalized)) {
      throw new InvalidDomainValueError(
        "organizationSlug",
        "Organization slug must contain only lowercase letters, numbers, and single hyphens"
      );
    }
    return new OrganizationSlug(normalized);
  }

  toString(): string {
    return this.#value;
  }
}
