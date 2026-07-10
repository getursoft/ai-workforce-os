import { InvalidDomainValueError, InvalidEntityStateError } from "./domain.error";

export function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidDomainValueError(field, `${field} is required`);
  }
  return trimmed;
}

export function requireValidDate(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new InvalidDomainValueError(field, `${field} must be a valid date`);
  }
  return new Date(value);
}

export function assertChronology(
  entity: string,
  earlier: Date,
  later: Date,
  message: string
): void {
  if (later.getTime() < earlier.getTime()) {
    throw new InvalidEntityStateError(entity, message);
  }
}

export function assertEnumValue<T extends string>(
  values: readonly T[],
  value: T,
  field: string
): void {
  if (!values.includes(value)) {
    throw new InvalidDomainValueError(field, `${field} is invalid`);
  }
}
