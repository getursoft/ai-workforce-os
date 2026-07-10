import { InvalidDomainValueError } from "../shared/domain.error";
import { requireNonBlank } from "../shared/validation";

export class OrganizationName {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static create(value: string): OrganizationName {
    const normalized = requireNonBlank(value, "organizationName");
    if (normalized.length < 2 || normalized.length > 120) {
      throw new InvalidDomainValueError(
        "organizationName",
        "Organization name must contain between 2 and 120 characters"
      );
    }
    return new OrganizationName(normalized);
  }

  toString(): string {
    return this.#value;
  }
}
