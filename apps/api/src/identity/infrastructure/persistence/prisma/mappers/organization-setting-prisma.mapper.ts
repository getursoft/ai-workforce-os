import type { OrganizationSetting as PrismaOrganizationSetting } from "@prisma/client";
import { OrganizationId } from "../../../../domain/organization/organization-id";
import { OrganizationSetting } from "../../../../domain/organization/organization-setting";
import { OrganizationSettingId } from "../../../../domain/organization/organization-setting-id";

export class OrganizationSettingPrismaMapper {
  static toDomain(record: PrismaOrganizationSetting): OrganizationSetting {
    return OrganizationSetting.reconstruct({
      id: OrganizationSettingId.from(record.id),
      organizationId: OrganizationId.from(record.organizationId),
      timezone: record.timezone,
      currency: record.currency,
      locale: record.locale,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    });
  }

  static toPersistence(setting: OrganizationSetting): OrganizationSettingPersistence {
    return {
      id: setting.id.toString(),
      organizationId: setting.organizationId.toString(),
      timezone: setting.timezone,
      currency: setting.currency,
      locale: setting.locale,
      createdAt: new Date(setting.createdAt),
      updatedAt: setting.updatedAt
    };
  }
}

export interface OrganizationSettingPersistence {
  id: string;
  organizationId: string;
  timezone: string;
  currency: string;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}
