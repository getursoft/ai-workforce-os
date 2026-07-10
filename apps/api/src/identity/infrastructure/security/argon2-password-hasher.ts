import * as argon2 from "argon2";
import { PasswordHashingError } from "../../application/errors/security.error";
import type { PasswordHasher } from "../../application/ports/password-hasher";
import type { SecurityConfig } from "./security-config";

type PasswordHashConfig = SecurityConfig["passwordHash"];

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly config: PasswordHashConfig) {}

  async hash(plainPassword: string): Promise<string> {
    this.requireInput(plainPassword);
    try {
      return await argon2.hash(plainPassword, {
        type: argon2.argon2id,
        memoryCost: this.config.memoryCost,
        timeCost: this.config.timeCost,
        parallelism: this.config.parallelism
      });
    } catch {
      throw new PasswordHashingError();
    }
  }

  async verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    this.requireInput(plainPassword);
    if (!passwordHash.startsWith("$argon2id$")) {
      return false;
    }
    try {
      return await argon2.verify(passwordHash, plainPassword);
    } catch {
      return false;
    }
  }

  private requireInput(plainPassword: string): void {
    if (plainPassword.length === 0) {
      throw new PasswordHashingError();
    }
  }
}
