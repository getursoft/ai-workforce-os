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

  /** Slug is unique, so an exact slug match is tried first and is inherently deterministic. Only when
   *  that misses does this fall back to a name match — which, unlike slug, has no uniqueness constraint,
   *  so two organizations can legitimately share a display name (e.g. after a rename collision). An
   *  unordered `findFirst` there previously let login resolve to either one nondeterministically; `asc`
   *  by `createdAt` pins it to the org that has held that name the longest. */
  async findByName(name: string): Promise<Organization | null> {
    const trimmed = name.trim();
    const bySlug = await this.client.organization.findUnique({
      where: { slug: trimmed.toLowerCase() }
    });
    if (bySlug) return OrganizationPrismaMapper.toDomain(bySlug);
    const byName = await this.client.organization.findFirst({
      where: { name: { equals: trimmed, mode: "insensitive" } },
      orderBy: { createdAt: "asc" }
    });
    return byName ? OrganizationPrismaMapper.toDomain(byName) : null;
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
