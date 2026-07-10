import { requireUuid } from "../shared/uuid";

export class TokenFamilyId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): TokenFamilyId {
    return new TokenFamilyId(requireUuid(value, "tokenFamilyId"));
  }

  equals(other: TokenFamilyId): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
