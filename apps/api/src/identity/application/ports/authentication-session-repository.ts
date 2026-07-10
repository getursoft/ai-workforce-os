import type { AuthenticationSession } from "../../domain/authentication/authentication-session";
import type { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import type { TokenFamilyId } from "../../domain/authentication/token-family-id";

export interface AuthenticationSessionRepository {
  findById(id: AuthenticationSessionId): Promise<AuthenticationSession | null>;
  save(session: AuthenticationSession): Promise<void>;
  revoke(
    id: AuthenticationSessionId,
    revokedAt: Date,
    replacedBySessionId: AuthenticationSessionId | null
  ): Promise<void>;
  revokeFamily(familyId: TokenFamilyId, revokedAt: Date): Promise<number>;
  rotate(
    currentId: AuthenticationSessionId,
    expectedTokenHash: string,
    replacement: AuthenticationSession,
    revokedAt: Date
  ): Promise<boolean>;
}

export const AUTHENTICATION_SESSION_REPOSITORY = Symbol("AuthenticationSessionRepository");
