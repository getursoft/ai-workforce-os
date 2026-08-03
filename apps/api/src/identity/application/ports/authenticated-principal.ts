import type { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import type { OrganizationId } from "../../domain/organization/organization-id";
import type { UserId } from "../../domain/user/user-id";
import type { UserRole } from "../../domain/user/user-role";

export interface AuthenticatedPrincipal {
  userId: UserId;
  organizationId: OrganizationId;
  role: UserRole;
  sessionId: AuthenticationSessionId;
  /** True for the universal platform owner (see SecurityConfig.platformOwnerEmail). Set in the JWT
   *  so guards/services can grant superadmin access without a database lookup per request. */
  isPlatformOwner?: boolean;
}
