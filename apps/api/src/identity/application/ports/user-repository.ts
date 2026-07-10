import type { Email } from "../../domain/user/email";
import type { User } from "../../domain/user/user";
import type { UserId } from "../../domain/user/user-id";

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByNormalizedEmail(email: Email): Promise<User | null>;
  existsByNormalizedEmail(email: Email): Promise<boolean>;
  save(user: User): Promise<void>;
  updateLastLogin(id: UserId, lastLoginAt: Date): Promise<void>;
}

export const USER_REPOSITORY = Symbol("UserRepository");
