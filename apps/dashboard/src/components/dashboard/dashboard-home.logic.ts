export function firstNameOrEmail(firstName: string | null, email: string | undefined): string {
  if (firstName) {
    return firstName;
  }
  return email?.split("@")[0] ?? "there";
}
