import { identityError } from "../errors/identity.error";
import type { Organization } from "../../domain/organization/organization";
import type { User } from "../../domain/user/user";
import { OrganizationStatus } from "../../domain/organization/organization-status";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { UserRepository } from "../ports/user-repository";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";

export interface AccessibleOrganization {
  user: User;
  organization: Organization;
}

export class OrganizationAccessService {
  constructor(
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository,
    private readonly platformOwner: PlatformOwnerService
  ) {}

  async resolve(principal: AuthenticatedPrincipal): Promise<AccessibleOrganization> {
    const user = await this.users.findById(principal.userId);
    if (!user) {
      throw identityError.userNotFound();
    }
    // The platform owner operates across every organization without a membership row: the principal's
    // organizationId is the one they are currently switched into (see /platform/organizations/:id/switch).
    if (!this.platformOwner.isPlatformOwnerPrincipal(principal)) {
      if (!user.organizationId.equals(principal.organizationId)) {
        throw identityError.authorizationFailed();
      }
    }
    if (!user.canAuthenticate()) {
      throw identityError.userInactive();
    }
    const organization = await this.organizations.findById(principal.organizationId);
    if (!organization) {
      throw identityError.organizationNotFound();
    }
    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw identityError.organizationInactive();
    }
    return { user, organization };
  }
}
