import { InvalidDomainValueError } from "../shared/domain.error";
import { assertChronology, requireNonBlank, requireValidDate } from "../shared/validation";
import type { OrganizationId } from "./organization-id";
import type { OrganizationSettingId } from "./organization-setting-id";

export const DEFAULT_ORGANIZATION_TIMEZONE = "UTC";
export const DEFAULT_ORGANIZATION_CURRENCY = "USD";
export const DEFAULT_ORGANIZATION_LOCALE = "en-US";

export interface CreateOrganizationSetting {
  id: OrganizationSettingId;
  organizationId: OrganizationId;
  timezone?: string;
  currency?: string;
  locale?: string;
  now?: Date;
}

export interface ReconstructedOrganizationSetting {
  id: OrganizationSettingId;
  organizationId: OrganizationId;
  timezone: string;
  currency: string;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationSettingUpdate {
  timezone?: string;
  currency?: string;
  locale?: string;
  now?: Date;
}

export class OrganizationSetting {
  #timezone: string;
  #currency: string;
  #locale: string;
  #updatedAt: Date;

  private constructor(
    readonly id: OrganizationSettingId,
    readonly organizationId: OrganizationId,
    timezone: string,
    currency: string,
    locale: string,
    readonly createdAt: Date,
    updatedAt: Date
  ) {
    this.#timezone = timezone;
    this.#currency = currency;
    this.#locale = locale;
    this.#updatedAt = updatedAt;
  }

  static create(properties: CreateOrganizationSetting): OrganizationSetting {
    const createdAt = requireValidDate(properties.now ?? new Date(), "createdAt");
    return new OrganizationSetting(
      properties.id,
      properties.organizationId,
      OrganizationSetting.normalizeTimezone(properties.timezone ?? DEFAULT_ORGANIZATION_TIMEZONE),
      OrganizationSetting.normalizeCurrency(properties.currency ?? DEFAULT_ORGANIZATION_CURRENCY),
      OrganizationSetting.normalizeLocale(properties.locale ?? DEFAULT_ORGANIZATION_LOCALE),
      createdAt,
      new Date(createdAt)
    );
  }

  static reconstruct(properties: ReconstructedOrganizationSetting): OrganizationSetting {
    const createdAt = requireValidDate(properties.createdAt, "createdAt");
    const updatedAt = requireValidDate(properties.updatedAt, "updatedAt");
    assertChronology(
      "OrganizationSetting",
      createdAt,
      updatedAt,
      "updatedAt cannot precede createdAt"
    );
    return new OrganizationSetting(
      properties.id,
      properties.organizationId,
      OrganizationSetting.normalizeTimezone(properties.timezone),
      OrganizationSetting.normalizeCurrency(properties.currency),
      OrganizationSetting.normalizeLocale(properties.locale),
      createdAt,
      updatedAt
    );
  }

  get timezone(): string {
    return this.#timezone;
  }

  get currency(): string {
    return this.#currency;
  }

  get locale(): string {
    return this.#locale;
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  update(properties: OrganizationSettingUpdate): void {
    const nextTimezone = properties.timezone
      ? OrganizationSetting.normalizeTimezone(properties.timezone)
      : this.#timezone;
    const nextCurrency = properties.currency
      ? OrganizationSetting.normalizeCurrency(properties.currency)
      : this.#currency;
    const nextLocale = properties.locale
      ? OrganizationSetting.normalizeLocale(properties.locale)
      : this.#locale;
    const updatedAt = requireValidDate(properties.now ?? new Date(), "updatedAt");
    this.#timezone = nextTimezone;
    this.#currency = nextCurrency;
    this.#locale = nextLocale;
    this.#updatedAt = updatedAt;
  }

  private static normalizeTimezone(value: string): string {
    const normalized = requireNonBlank(value, "timezone");
    try {
      const resolved = new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions()
        .timeZone;
      if (!resolved) {
        throw new Error("Invalid timezone");
      }
      return resolved;
    } catch {
      throw new InvalidDomainValueError("timezone", "Timezone must be a valid IANA timezone");
    }
  }

  private static normalizeCurrency(value: string): string {
    const normalized = requireNonBlank(value, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
      throw new InvalidDomainValueError("currency", "Currency must be a valid ISO-4217 code");
    }
    return normalized;
  }

  private static normalizeLocale(value: string): string {
    const normalized = requireNonBlank(value, "locale");
    try {
      const canonical = Intl.getCanonicalLocales(normalized)[0];
      if (!canonical || Intl.DateTimeFormat.supportedLocalesOf([canonical]).length === 0) {
        throw new Error("Unsupported locale");
      }
      return canonical;
    } catch {
      throw new InvalidDomainValueError("locale", "Locale must be a valid BCP-47 locale");
    }
  }
}
