import { publicOrganization, publicUser, type CurrentUserResult } from "../models/identity-result";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { UserRepository } from "../ports/user-repository";
import { OrganizationAccessService } from "../services/organization-access";

export const GET_CURRENT_USER = Symbol("GetCurrentUser");

export class GetCurrentUserHandler {
  private readonly organizationAccess: OrganizationAccessService;

  constructor(users: UserRepository, organizations: OrganizationRepository) {
    this.organizationAccess = new OrganizationAccessService(users, organizations);
  }

  async execute(principal: AuthenticatedPrincipal): Promise<CurrentUserResult> {
    const { user, organization } = await this.organizationAccess.resolve(principal);
    return { organization: publicOrganization(organization), user: publicUser(user) };
  }
}
