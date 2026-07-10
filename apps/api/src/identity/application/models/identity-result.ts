import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { Organization } from "../../domain/organization/organization";
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

export function publicUser(user: User): PublicUser {
  return {
    id: user.id.toString(),
    organizationId: user.organizationId.toString(),
    firstName: user.firstName,
    ...(user.lastName ? { lastName: user.lastName } : {}),
    email: user.email.toString(),
    role: user.role,
    status: user.status
  };
}

export function principalFor(
  user: User,
  sessionId: AuthenticatedPrincipal["sessionId"]
): AuthenticatedPrincipal {
  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    sessionId
  };
}
