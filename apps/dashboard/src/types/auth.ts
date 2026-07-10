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

export interface AuthenticationTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthenticationResult {
  organization: PublicOrganization;
  user: PublicUser;
  tokens: AuthenticationTokens;
}

export interface CurrentUserResult {
  organization: PublicOrganization;
  user: PublicUser;
}

export interface AuthState {
  user: PublicUser | null;
  organization: PublicOrganization | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
}
