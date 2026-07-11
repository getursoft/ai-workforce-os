import { requireUuid } from "../shared/uuid";

export class OrganizationSettingId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): OrganizationSettingId {
    return new OrganizationSettingId(requireUuid(value, "organizationSettingId"));
  }

  equals(other: OrganizationSettingId): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
