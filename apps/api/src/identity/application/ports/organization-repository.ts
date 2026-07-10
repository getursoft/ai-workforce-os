import type { Organization } from "../../domain/organization/organization";
import type { OrganizationId } from "../../domain/organization/organization-id";
import type { OrganizationSlug } from "../../domain/organization/organization-slug";

export interface OrganizationRepository {
  findById(id: OrganizationId): Promise<Organization | null>;
  findBySlug(slug: OrganizationSlug): Promise<Organization | null>;
  existsBySlug(slug: OrganizationSlug): Promise<boolean>;
  save(organization: Organization): Promise<void>;
}

export const ORGANIZATION_REPOSITORY = Symbol("OrganizationRepository");
