import type { OrganizationId } from "../../domain/organization/organization-id";
import type { OrganizationSetting } from "../../domain/organization/organization-setting";

export interface OrganizationSettingRepository {
  findByOrganizationId(organizationId: OrganizationId): Promise<OrganizationSetting | null>;
  save(setting: OrganizationSetting): Promise<void>;
}

export const ORGANIZATION_SETTING_REPOSITORY = Symbol("OrganizationSettingRepository");
