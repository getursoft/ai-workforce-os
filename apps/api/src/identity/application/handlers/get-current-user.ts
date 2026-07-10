import { identityError } from "../errors/identity.error";
import { publicOrganization, publicUser, type CurrentUserResult } from "../models/identity-result";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { UserRepository } from "../ports/user-repository";
import { OrganizationStatus } from "../../domain/organization/organization-status";

export const GET_CURRENT_USER = Symbol("GetCurrentUser");

export class GetCurrentUserHandler {
  constructor(
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository
  ) {}

  async execute(principal: AuthenticatedPrincipal): Promise<CurrentUserResult> {
    const user = await this.users.findById(principal.userId);
    if (!user) {
      throw identityError.userNotFound();
    }
    if (!user.organizationId.equals(principal.organizationId)) {
      throw identityError.authorizationFailed();
    }
    if (!user.canAuthenticate()) {
      throw identityError.userInactive();
    }
    const organization = await this.organizations.findById(user.organizationId);
    if (!organization) {
      throw identityError.organizationNotFound();
    }
    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw identityError.organizationInactive();
    }
    return { organization: publicOrganization(organization), user: publicUser(user) };
  }
}
