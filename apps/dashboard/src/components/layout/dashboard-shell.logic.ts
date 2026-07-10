export function displayName(firstName?: string, lastName?: string): string {
  return [firstName, lastName].filter(Boolean).join(" ") || "Account";
}

export function toggleSidebar(open: boolean): boolean {
  return !open;
}
