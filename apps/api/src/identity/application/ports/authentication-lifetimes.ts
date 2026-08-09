export interface AuthenticationLifetimes {
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
  accountLockout: {
    maxFailedAttempts: number;
    lockoutDurationSeconds: number;
  };
}

export const AUTHENTICATION_LIFETIMES = Symbol("AuthenticationLifetimes");
