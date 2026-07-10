import type { AuthenticatedPrincipal } from "./authenticated-principal";

export interface AccessTokenService {
  issue(principal: AuthenticatedPrincipal, issuedAt: Date): Promise<string>;
  verify(token: string): Promise<AuthenticatedPrincipal>;
}

export const ACCESS_TOKEN_SERVICE = Symbol("AccessTokenService");
