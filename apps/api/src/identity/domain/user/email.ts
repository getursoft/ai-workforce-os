import { InvalidDomainValueError } from "../shared/domain.error";
import { requireNonBlank } from "../shared/validation";

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Email {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static create(value: string): Email {
    const normalized = requireNonBlank(value, "email").toLowerCase();
    if (normalized.length > 254 || !VALID_EMAIL.test(normalized)) {
      throw new InvalidDomainValueError("email", "Email address is invalid");
    }
    return new Email(normalized);
  }

  equals(other: Email): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
