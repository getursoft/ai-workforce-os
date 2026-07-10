import type { OrganizationRepository } from "../../../../application/ports/organization-repository";
import type { Organization } from "../../../../domain/organization/organization";
import type { OrganizationId } from "../../../../domain/organization/organization-id";
import type { OrganizationSlug } from "../../../../domain/organization/organization-slug";
import type { IdentityPrismaClient } from "../identity-prisma-client";
import { translateKnownPrismaError } from "../prisma-error";
import { OrganizationPrismaMapper } from "../mappers/organization-prisma.mapper";

export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly client: IdentityPrismaClient) {}

  async findById(id: OrganizationId): Promise<Organization | null> {
    const record = await this.client.organization.findUnique({ where: { id: id.toString() } });
    return record ? OrganizationPrismaMapper.toDomain(record) : null;
  }

  async findBySlug(slug: OrganizationSlug): Promise<Organization | null> {
    const record = await this.client.organization.findUnique({ where: { slug: slug.toString() } });
    return record ? OrganizationPrismaMapper.toDomain(record) : null;
  }

  async existsBySlug(slug: OrganizationSlug): Promise<boolean> {
    const count = await this.client.organization.count({ where: { slug: slug.toString() } });
    return count > 0;
  }

  async save(organization: Organization): Promise<void> {
    const data = OrganizationPrismaMapper.toPersistence(organization);
    try {
      await this.client.organization.upsert({
        where: { id: data.id },
        create: data,
        update: {
          name: data.name,
          slug: data.slug,
          status: data.status,
          updatedAt: data.updatedAt
        }
      });
    } catch (error: unknown) {
      translateKnownPrismaError(error);
    }
  }
}
