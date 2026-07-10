import { identityError } from "../errors/identity.error";

export function validatePassword(password: string): void {
  const valid =
    password.length >= 12 &&
    password.length <= 128 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password) &&
    password.trim().length > 0;
  if (!valid) {
    throw identityError.validation(["password does not meet the security policy"]);
  }
}
