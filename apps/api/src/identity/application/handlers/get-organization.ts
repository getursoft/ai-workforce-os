import { publicOrganizationSummary, type OrganizationResult } from "../models/organization-result";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { UserRepository } from "../ports/user-repository";
import { OrganizationAccessService } from "../services/organization-access";

export const GET_ORGANIZATION = Symbol("GetOrganization");

export class GetOrganizationHandler {
  private readonly organizationAccess: OrganizationAccessService;

  constructor(
    users: UserRepository,
    organizations: OrganizationRepository
  ) {
    this.organizationAccess = new OrganizationAccessService(users, organizations);
  }

  async execute(principal: AuthenticatedPrincipal): Promise<OrganizationResult> {
    const { organization } = await this.organizationAccess.resolve(principal);
    return { organization: publicOrganizationSummary(organization) };
  }
}
