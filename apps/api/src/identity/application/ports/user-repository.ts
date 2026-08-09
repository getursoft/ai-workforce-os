import type { Email } from "../../domain/user/email";
import type { User } from "../../domain/user/user";
import type { UserId } from "../../domain/user/user-id";

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByNormalizedEmail(email: Email): Promise<User | null>;
  existsByNormalizedEmail(email: Email): Promise<boolean>;
  save(user: User): Promise<void>;
  /** Persists a successful login: updates lastLoginAt and clears any lockout state. */
  updateLastLogin(id: UserId, lastLoginAt: Date): Promise<void>;
  /** Records a failed login attempt, locking the account once `maxFailedAttempts` is reached. */
  recordFailedLogin(
    id: UserId,
    maxFailedAttempts: number,
    lockoutDurationSeconds: number,
    at: Date
  ): Promise<void>;
}

export const USER_REPOSITORY = Symbol("UserRepository");
