export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationSettings {
  id: string;
  organizationId: string;
  timezone: string;
  locale: string;
  currency: string;
}

export interface UpdateOrganizationRequest {
  name: string;
}

export interface UpdateSettingsRequest {
  timezone: string;
  locale: string;
  currency: string;
}

export interface OrganizationResult {
  organization: Organization;
}

export interface OrganizationSettingsResult {
  organizationSetting: OrganizationSettings;
}
