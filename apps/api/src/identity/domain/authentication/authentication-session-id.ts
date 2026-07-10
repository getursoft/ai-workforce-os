import { requireUuid } from "../shared/uuid";

export class AuthenticationSessionId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): AuthenticationSessionId {
    return new AuthenticationSessionId(requireUuid(value, "authenticationSessionId"));
  }

  equals(other: AuthenticationSessionId): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
