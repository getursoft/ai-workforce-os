import { Ajv } from "ajv";
import type { SkillCapabilityKey, SkillPermissionKey } from "../types/permissions.js";
import {
  SKILL_CAPABILITY_KEYS,
  SKILL_PERMISSION_KEYS
} from "../types/permissions.js";
import type { SkillManifest } from "../types/manifest.js";
import { isValidSemver } from "../version/semver.js";

const KEY_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class SkillManifestValidationError extends Error {
  constructor(readonly details: readonly string[]) {
    super("SKILL_MANIFEST_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a skill manifest using runtime schema validation (Ajv), not TypeScript types alone.
 * Enforces stable keys, semantic versions, JSON-schema input/output/config schemas, allowed
 * permission/capability keys, dependency shape, and rejects prototype-pollution keys.
 */
export class SkillManifestValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });

  validate(value: unknown): SkillManifest {
    if (!isRecord(value)) throw new SkillManifestValidationError(["manifest must be an object"]);
    const errors: string[] = [];
    for (const key of Object.keys(value)) if (FORBIDDEN_KEYS.has(key)) errors.push(`unsupported field: ${key}`);

    const required = [
      "key",
      "name",
      "description",
      "category",
      "version",
      "author",
      "visibility",
      "supportedMimeTypes",
      "inputSchema",
      "outputSchema",
      "requiredPermissions",
      "requiredCapabilities",
      "dependencies",
      "billingCategory",
      "timeoutMs",
      "statefulness",
      "capabilitySummary"
    ];
    for (const key of required) if (!(key in value)) errors.push(`${key} is required`);

    if (typeof value.key !== "string" || !KEY_PATTERN.test(value.key))
      errors.push("key must be a slug-like identifier");
    for (const key of ["name", "description", "category", "version", "author", "visibility"])
      if (typeof value[key] !== "string" || !(value[key] as string).trim())
        errors.push(`${key} must be a non-blank string`);
    if (typeof value.version === "string" && !isValidSemver(value.version))
      errors.push("version must be a valid semantic version");

    if (!["PUBLIC", "PRIVATE", "ORG_ONLY"].includes(String(value.visibility)))
      errors.push("visibility must be PUBLIC, PRIVATE or ORG_ONLY");
    if (!["STATELESS", "STATEFUL"].includes(String(value.statefulness)))
      errors.push("statefulness must be STATELESS or STATEFUL");
    if (!["DETERMINISTIC", "CPU_INTENSIVE", "AI_PROVIDER_BACKED", "EXTERNAL_PROVIDER_BACKED", "STORAGE_HEAVY"].includes(String(value.billingCategory)))
      errors.push("billingCategory is unsupported");
    if (typeof value.timeoutMs !== "number" || value.timeoutMs < 1 || value.timeoutMs > 300_000)
      errors.push("timeoutMs must be between 1 and 300000");

    if (!Array.isArray(value.supportedMimeTypes) || value.supportedMimeTypes.some((x) => typeof x !== "string"))
      errors.push("supportedMimeTypes must be an array of strings");
    if (!Array.isArray(value.requiredPermissions) || value.requiredPermissions.some((x) => !SKILL_PERMISSION_KEYS.includes(x as SkillPermissionKey)))
      errors.push("requiredPermissions contain an unsupported value");
    if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.some((x) => !SKILL_CAPABILITY_KEYS.includes(x as SkillCapabilityKey)))
      errors.push("requiredCapabilities contain an unsupported value");
    if (new Set(value.requiredPermissions as string[]).size !== (value.requiredPermissions as unknown[]).length)
      errors.push("requiredPermissions must be unique");
    if (new Set(value.requiredCapabilities as string[]).size !== (value.requiredCapabilities as unknown[]).length)
      errors.push("requiredCapabilities must be unique");
    if (!Array.isArray(value.capabilitySummary) || value.capabilitySummary.some((x) => typeof x !== "string"))
      errors.push("capabilitySummary must be an array of strings");

    if (!isRecord(value.inputSchema)) errors.push("inputSchema must be an object");
    else {
      const result = this.compileSchema("inputSchema", value.inputSchema);
      if (!result.ok) errors.push(result.error);
    }
    if (!isRecord(value.outputSchema)) errors.push("outputSchema must be an object");
    else {
      const result = this.compileSchema("outputSchema", value.outputSchema);
      if (!result.ok) errors.push(result.error);
    }
    if (value.configurationSchema !== undefined) {
      if (!isRecord(value.configurationSchema)) errors.push("configurationSchema must be an object");
      else {
        const result = this.compileSchema("configurationSchema", value.configurationSchema);
        if (!result.ok) errors.push(result.error);
      }
    }

    if (!Array.isArray(value.dependencies)) errors.push("dependencies must be an array");
    else {
      const keys: string[] = [];
      for (const dep of value.dependencies) {
        if (!isRecord(dep) || typeof dep.skillKey !== "string" || typeof dep.versionConstraint !== "string") {
          errors.push("dependencies must contain skillKey and versionConstraint");
          continue;
        }
        if (!KEY_PATTERN.test(dep.skillKey)) errors.push(`dependency key invalid: ${dep.skillKey}`);
        if (!isValidSemverConstraint(dep.versionConstraint)) errors.push(`dependency versionConstraint invalid: ${dep.versionConstraint}`);
        keys.push(dep.skillKey);
      }
      if (new Set(keys).size !== keys.length) errors.push("dependencies must be unique");
    }

    if (value.retryPolicy !== undefined) {
      const policy = value.retryPolicy;
      if (!isRecord(policy) || typeof policy.maxRetries !== "number" || policy.maxRetries < 0 || policy.maxRetries > 10)
        errors.push("retryPolicy.maxRetries must be between 0 and 10");
      else if (typeof policy.backoffMs !== "number" || policy.backoffMs < 0 || policy.backoffMs > 60_000)
        errors.push("retryPolicy.backoffMs must be between 0 and 60000");
    }

    if (errors.length) throw new SkillManifestValidationError(errors);
    return value as unknown as SkillManifest;
  }

  /** Compiles `schema` fresh every call — deliberately uncached. A cache keyed by the generic
   *  `name` ("inputSchema"/"outputSchema"/"configurationSchema") rather than the schema's own
   *  content would silently reuse the first-ever compiled validator for every later manifest,
   *  masking a genuinely malformed schema on every call after the first valid one. Manifest
   *  validation runs rarely (install/publish time), so there is no meaningful cost to paying for
   *  a fresh Ajv compile on every call. */
  private compileSchema(name: string, schema: unknown): { ok: true } | { ok: false; error: string } {
    try {
      this.ajv.compile(schema as Record<string, unknown>);
      return { ok: true };
    } catch {
      return { ok: false, error: `${name} is not a valid JSON schema` };
    }
  }
}

function isValidSemverConstraint(constraint: string): boolean {
  try {
    return constraint.trim().length > 0;
  } catch {
    return false;
  }
}
