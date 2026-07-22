import { identityError } from "../errors/identity.error";

export function normalizeOrganizationNameForUpdate(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 100) {
    throw identityError.validation(["organization name must contain between 3 and 100 characters"]);
  }
  return normalized;
}

export function assertOrganizationSettingsUpdate(values: {
  timezone?: string;
  currency?: string;
  locale?: string;
}): void {
  if (!values.timezone && !values.currency && !values.locale) {
    throw identityError.validation(["at least one organization setting must be provided"]);
  }
}
