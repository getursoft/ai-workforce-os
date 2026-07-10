export interface AuthenticationLifetimes {
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

export const AUTHENTICATION_LIFETIMES = Symbol("AuthenticationLifetimes");
