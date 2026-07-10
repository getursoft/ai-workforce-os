import { describe, expect, it } from "vitest";
import { PasswordHashingError } from "../../application/errors/security.error";
import { Argon2PasswordHasher } from "./argon2-password-hasher";

const hasher = new Argon2PasswordHasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 });

describe("Argon2PasswordHasher", () => {
  it("hashes a valid password with Argon2id", async () => {
    const hash = await hasher.hash("correct horse battery staple");

    expect(hash).not.toBe("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("verifies the correct password", async () => {
    const hash = await hasher.hash("correct password");
    await expect(hasher.verify("correct password", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hasher.hash("correct password");
    await expect(hasher.verify("incorrect password", hash)).resolves.toBe(false);
  });

  it("handles a malformed hash safely", async () => {
    await expect(hasher.verify("password", "not-an-argon2-hash")).resolves.toBe(false);
    await expect(hasher.verify("password", "$argon2i$v=19$m=8192,t=1,p=1$invalid")).resolves.toBe(
      false
    );
  });

  it("rejects an empty password", async () => {
    await expect(hasher.hash("")).rejects.toBeInstanceOf(PasswordHashingError);
    await expect(hasher.verify("", "$argon2id$malformed")).rejects.toBeInstanceOf(
      PasswordHashingError
    );
  });
});
