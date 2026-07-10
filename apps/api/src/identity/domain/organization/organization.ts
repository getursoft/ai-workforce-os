import type { OrganizationId } from "./organization-id";
import type { OrganizationName } from "./organization-name";
import type { OrganizationSlug } from "./organization-slug";
import { OrganizationStatus } from "./organization-status";
import { assertChronology, assertEnumValue, requireValidDate } from "../shared/validation";

export interface ReconstructedOrganization {
  id: OrganizationId;
  name: OrganizationName;
  slug: OrganizationSlug;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class Organization {
  private constructor(
    readonly id: OrganizationId,
    readonly name: OrganizationName,
    readonly slug: OrganizationSlug,
    readonly status: OrganizationStatus,
    readonly createdAt: Date,
    readonly updatedAt: Date
  ) {}

  static create(
    id: OrganizationId,
    name: OrganizationName,
    slug: OrganizationSlug,
    now = new Date()
  ): Organization {
    const createdAt = requireValidDate(now, "createdAt");
    return new Organization(
      id,
      name,
      slug,
      OrganizationStatus.ACTIVE,
      createdAt,
      new Date(createdAt)
    );
  }

  static reconstruct(properties: ReconstructedOrganization): Organization {
    assertEnumValue(Object.values(OrganizationStatus), properties.status, "organizationStatus");
    const createdAt = requireValidDate(properties.createdAt, "createdAt");
    const updatedAt = requireValidDate(properties.updatedAt, "updatedAt");
    assertChronology("Organization", createdAt, updatedAt, "updatedAt cannot precede createdAt");
    return new Organization(
      properties.id,
      properties.name,
      properties.slug,
      properties.status,
      createdAt,
      updatedAt
    );
  }
}
