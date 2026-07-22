export function isSafeInternalPath(value: string | null | undefined): value is string {
  if (!value || typeof value !== "string") {
    return false;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  if (value.startsWith("//")) {
    return false;
  }
  return !value.includes("\\");
}

export function resolveReturnUrl(
  value: string | null | undefined,
  fallback = "/dashboard"
): string {
  return isSafeInternalPath(value) ? value : fallback;
}

export function buildLoginRedirectPath(returnUrl: string): string {
  const safeReturnUrl = resolveReturnUrl(returnUrl);
  return `/login?returnUrl=${encodeURIComponent(safeReturnUrl)}`;
}
