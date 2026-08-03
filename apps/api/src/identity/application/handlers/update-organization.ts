import { publicOrganizationSummary, type OrganizationResult } from "../models/organization-result";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { UserRepository } from "../ports/user-repository";
import { Organization } from "../../domain/organization/organization";
import { OrganizationName } from "../../domain/organization/organization-name";
import { OrganizationAccessService } from "../services/organization-access";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { normalizeOrganizationNameForUpdate } from "../services/organization-update-policy";

export interface UpdateOrganizationCommand {
  name: string;
}

export const UPDATE_ORGANIZATION = Symbol("UpdateOrganization");

export class UpdateOrganizationHandler {
  private readonly organizationAccess: OrganizationAccessService;

  constructor(
    users: UserRepository,
    organizations: OrganizationRepository,
    private readonly unitOfWork: IdentityUnitOfWork,
    platformOwner: PlatformOwnerService
  ) {
    this.organizationAccess = new OrganizationAccessService(users, organizations, platformOwner);
  }

  async execute(
    principal: AuthenticatedPrincipal,
    command: UpdateOrganizationCommand
  ): Promise<OrganizationResult> {
    const { organization } = await this.organizationAccess.resolve(principal);
    const name = normalizeOrganizationNameForUpdate(command.name);
    const updated = Organization.reconstruct({
      id: organization.id,
      name: OrganizationName.create(name),
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt,
      updatedAt: new Date()
    });
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.organizations.save(updated);
    });
    return { organization: publicOrganizationSummary(updated) };
  }
}
