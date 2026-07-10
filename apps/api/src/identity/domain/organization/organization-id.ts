import { requireUuid } from "../shared/uuid";

export class OrganizationId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): OrganizationId {
    return new OrganizationId(requireUuid(value, "organizationId"));
  }

  equals(other: OrganizationId): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
