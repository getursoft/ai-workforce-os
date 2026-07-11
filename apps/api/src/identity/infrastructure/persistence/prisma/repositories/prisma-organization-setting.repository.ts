import type { OrganizationId } from "../../../../domain/organization/organization-id";
import type { OrganizationSetting } from "../../../../domain/organization/organization-setting";
import type { OrganizationSettingRepository } from "../../../../application/ports/organization-setting-repository";
import type { IdentityPrismaClient } from "../identity-prisma-client";
import { translateKnownPrismaError } from "../prisma-error";
import { OrganizationSettingPrismaMapper } from "../mappers/organization-setting-prisma.mapper";

export class PrismaOrganizationSettingRepository implements OrganizationSettingRepository {
  constructor(private readonly client: IdentityPrismaClient) {}

  async findByOrganizationId(organizationId: OrganizationId): Promise<OrganizationSetting | null> {
    const record = await this.client.organizationSetting.findUnique({
      where: { organizationId: organizationId.toString() }
    });
    return record ? OrganizationSettingPrismaMapper.toDomain(record) : null;
  }

  async save(setting: OrganizationSetting): Promise<void> {
    const data = OrganizationSettingPrismaMapper.toPersistence(setting);
    try {
      await this.client.organizationSetting.upsert({
        where: { organizationId: data.organizationId },
        create: data,
        update: {
          timezone: data.timezone,
          currency: data.currency,
          locale: data.locale,
          updatedAt: data.updatedAt
        }
      });
    } catch (error: unknown) {
      translateKnownPrismaError(error);
    }
  }
}
