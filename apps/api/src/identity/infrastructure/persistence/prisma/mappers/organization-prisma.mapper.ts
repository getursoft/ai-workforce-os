import {
  OrganizationStatus as PrismaOrganizationStatus,
  type Organization as PrismaOrganization
} from "@prisma/client";
import { Organization } from "../../../../domain/organization/organization";
import { OrganizationId } from "../../../../domain/organization/organization-id";
import { OrganizationName } from "../../../../domain/organization/organization-name";
import { OrganizationSlug } from "../../../../domain/organization/organization-slug";
import { OrganizationStatus } from "../../../../domain/organization/organization-status";

export class OrganizationPrismaMapper {
  static toDomain(record: PrismaOrganization): Organization {
    return Organization.reconstruct({
      id: OrganizationId.from(record.id),
      name: OrganizationName.create(record.name),
      slug: OrganizationSlug.create(record.slug),
      status: this.toDomainStatus(record.status),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    });
  }

  static toPersistence(organization: Organization): OrganizationPersistence {
    return {
      id: organization.id.toString(),
      name: organization.name.toString(),
      slug: organization.slug.toString(),
      status: this.toPrismaStatus(organization.status),
      createdAt: new Date(organization.createdAt),
      updatedAt: new Date(organization.updatedAt)
    };
  }

  private static toDomainStatus(status: PrismaOrganizationStatus): OrganizationStatus {
    switch (status) {
      case PrismaOrganizationStatus.ACTIVE:
        return OrganizationStatus.ACTIVE;
      case PrismaOrganizationStatus.SUSPENDED:
        return OrganizationStatus.SUSPENDED;
      case PrismaOrganizationStatus.DISABLED:
        return OrganizationStatus.DISABLED;
    }
  }

  private static toPrismaStatus(status: OrganizationStatus): PrismaOrganizationStatus {
    switch (status) {
      case OrganizationStatus.ACTIVE:
        return PrismaOrganizationStatus.ACTIVE;
      case OrganizationStatus.SUSPENDED:
        return PrismaOrganizationStatus.SUSPENDED;
      case OrganizationStatus.DISABLED:
        return PrismaOrganizationStatus.DISABLED;
    }
  }
}

export interface OrganizationPersistence {
  id: string;
  name: string;
  slug: string;
  status: PrismaOrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}
