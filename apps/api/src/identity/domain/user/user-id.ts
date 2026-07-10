import { requireUuid } from "../shared/uuid";

export class UserId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): UserId {
    return new UserId(requireUuid(value, "userId"));
  }

  equals(other: UserId): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
