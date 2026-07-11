import type { OrganizationSetting } from "../../domain/organization/organization-setting";
import type { Organization } from "../../domain/organization/organization";

export interface OrganizationResult {
  organization: PublicOrganizationSummary;
}

export interface OrganizationSettingsResult {
  organizationSetting: PublicOrganizationSetting;
}

export interface PublicOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface PublicOrganizationSetting {
  id: string;
  organizationId: string;
  timezone: string;
  currency: string;
  locale: string;
}

export function publicOrganizationSetting(setting: OrganizationSetting): PublicOrganizationSetting {
  return {
    id: setting.id.toString(),
    organizationId: setting.organizationId.toString(),
    timezone: setting.timezone,
    currency: setting.currency,
    locale: setting.locale
  };
}

export function publicOrganizationSummary(organization: Organization): PublicOrganizationSummary {
  return {
    id: organization.id.toString(),
    name: organization.name.toString(),
    slug: organization.slug.toString(),
    status: organization.status
  };
}
