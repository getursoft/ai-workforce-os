import { requireNonBlank } from "../shared/validation";

export class PasswordHash {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static create(value: string): PasswordHash {
    return new PasswordHash(requireNonBlank(value, "passwordHash"));
  }

  matches(value: string): boolean {
    return this.#value === value;
  }

  persistenceValue(): string {
    return this.#value;
  }
}
