import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { Organization } from "../../domain/organization/organization";
import type { OrganizationId } from "../../domain/organization/organization-id";
import type { User } from "../../domain/user/user";

export interface PublicOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface PublicUser {
  id: string;
  organizationId: string;
  firstName: string;
  lastName?: string;
  email: string;
  role: string;
  status: string;
  /** True when this is the universal platform owner (see SecurityConfig.platformOwnerEmail). */
  isPlatformOwner: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthenticationResult {
  organization: PublicOrganization;
  user: PublicUser;
  tokens: TokenPair;
}

export interface CurrentUserResult {
  organization: PublicOrganization;
  user: PublicUser;
}

export function publicOrganization(organization: Organization): PublicOrganization {
  return {
    id: organization.id.toString(),
    name: organization.name.toString(),
    slug: organization.slug.toString(),
    status: organization.status
  };
}

export function publicUser(user: User, isPlatformOwner = false): PublicUser {
  return {
    id: user.id.toString(),
    organizationId: user.organizationId.toString(),
    firstName: user.firstName,
    ...(user.lastName ? { lastName: user.lastName } : {}),
    email: user.email.toString(),
    role: user.role,
    status: user.status,
    isPlatformOwner
  };
}

export function principalFor(
  user: User,
  sessionId: AuthenticatedPrincipal["sessionId"],
  options: { isPlatformOwner?: boolean; organizationId?: OrganizationId } = {}
): AuthenticatedPrincipal {
  return {
    userId: user.id,
    organizationId: options.organizationId ?? user.organizationId,
    role: user.role,
    sessionId,
    ...(options.isPlatformOwner ? { isPlatformOwner: true } : {})
  };
}
