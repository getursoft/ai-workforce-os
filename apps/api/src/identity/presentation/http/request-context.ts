import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";

export interface IdentityRequest {
  requestId: string;
  principal?: AuthenticatedPrincipal;
  servicePermissions?: readonly string[];
  header(name: string): string | undefined;
}

export interface IdentityResponse {
  setHeader(name: string, value: string): void;
  status(code: number): IdentityResponse;
  json(body: unknown): void;
}
