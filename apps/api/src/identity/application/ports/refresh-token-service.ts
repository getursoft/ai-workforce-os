import type { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";

export interface ParsedRefreshToken {
  sessionId: AuthenticationSessionId;
}

export interface RefreshTokenService {
  generate(sessionId: AuthenticationSessionId): string;
  parse(rawToken: string): ParsedRefreshToken;
  hash(rawToken: string): string;
  verifyHash(rawToken: string, storedHash: string): boolean;
}

export const REFRESH_TOKEN_SERVICE = Symbol("RefreshTokenService");
