import semver from "semver";

/**
 * Version constraint helpers built on semantic versioning. Supports exact versions, caret/tilde
 * ranges, and any semver range expression.
 */

export function isValidSemver(value: string): boolean {
  return semver.valid(value) !== null;
}

/** True when `version` satisfies the semver `constraint` (e.g. "^1.0.0", ">=1.2.0 <2.0.0"). */
export function versionSatisfies(version: string, constraint: string): boolean {
  if (!isValidSemver(version)) return false;
  try {
    return semver.satisfies(version, constraint);
  } catch {
    return false;
  }
}

/** Picks the highest version from `versions` that satisfies `constraint`, or null. */
export function resolveCompatibleVersion(
  versions: readonly string[],
  constraint: string
): string | null {
  const candidates = versions
    .filter((version) => isValidSemver(version) && versionSatisfies(version, constraint))
    .sort((a, b) => (semver.gt(a, b) ? -1 : 1));
  return candidates[0] ?? null;
}

/** Picks the highest stable (non-prerelease) version, or null. */
export function latestVersion(versions: readonly string[]): string | null {
  const stable = versions.filter((version) => isValidSemver(version) && !semver.prerelease(version));
  const sorted = stable.sort((a, b) => (semver.gt(a, b) ? -1 : 1));
  return sorted[0] ?? null;
}

/** True when moving from `from` to `to` is a compatible (same major) upgrade. */
export function isCompatibleUpgrade(from: string, to: string): boolean {
  if (!isValidSemver(from) || !isValidSemver(to)) return false;
  return semver.major(from) === semver.major(to) && semver.gte(to, from);
}

export function major(version: string): number | null {
  return isValidSemver(version) ? semver.major(version) : null;
}
