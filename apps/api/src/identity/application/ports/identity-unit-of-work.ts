import type { AuthenticationSessionRepository } from "./authentication-session-repository";
import type { OrganizationRepository } from "./organization-repository";
import type { UserRepository } from "./user-repository";

export interface IdentityRepositories {
  organizations: OrganizationRepository;
  users: UserRepository;
  sessions: AuthenticationSessionRepository;
}

export interface IdentityUnitOfWork {
  execute<T>(callback: (repositories: IdentityRepositories) => Promise<T>): Promise<T>;
}

export const IDENTITY_UNIT_OF_WORK = Symbol("IdentityUnitOfWork");
