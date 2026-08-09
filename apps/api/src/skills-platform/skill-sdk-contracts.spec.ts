import { describe, expect, it } from "vitest";
import {
  SkillManifestValidator,
  SkillManifestValidationError,
  isValidSemver,
  versionSatisfies,
  resolveCompatibleVersion,
  latestVersion,
  isCompatibleUpgrade,
  major,
  type SkillManifest
} from "@ai-workforce-os/skill-sdk";

function baseManifest(overrides: Partial<SkillManifest> = {}): unknown {
  return {
    key: "sample-skill",
    name: "Sample Skill",
    description: "A sample skill for tests.",
    category: "Testing",
    version: "1.0.0",
    author: "Krevia.ai",
    visibility: "PUBLIC",
    supportedMimeTypes: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    requiredPermissions: ["skill.execute"],
    requiredCapabilities: [],
    dependencies: [],
    billingCategory: "DETERMINISTIC",
    timeoutMs: 5000,
    statefulness: "STATELESS",
    capabilitySummary: ["Do a sample thing"],
    ...overrides
  };
}

describe("SkillManifestValidator", () => {
  const validator = new SkillManifestValidator();

  it("accepts a valid manifest", () => {
    expect(() => validator.validate(baseManifest())).not.toThrow();
  });

  it("rejects an invalid semantic version", () => {
    expect(() => validator.validate(baseManifest({ version: "not-a-version" }))).toThrow(SkillManifestValidationError);
  });

  it("rejects a manifest whose inputSchema is not a valid JSON schema", () => {
    // An unparsable regex in `pattern` reliably fails at Ajv compile time (`new RegExp(...)` throws) —
    // unlike an unrecognized `type` string, which Ajv silently never matches rather than rejecting.
    expect(() =>
      validator.validate(
        baseManifest({ inputSchema: { type: "object", properties: { x: { type: "string", pattern: "[unterminated" } } } })
      )
    ).toThrow(SkillManifestValidationError);
  });

  it("rejects a manifest whose outputSchema is not an object", () => {
    expect(() => validator.validate(baseManifest({ outputSchema: "nope" }))).toThrow(SkillManifestValidationError);
  });

  it("rejects an unsupported permission key (permission declaration must use stable keys)", () => {
    expect(() => validator.validate(baseManifest({ requiredPermissions: ["not.a.real.permission"] }))).toThrow(
      SkillManifestValidationError
    );
  });

  it("rejects duplicate permission keys", () => {
    expect(() =>
      validator.validate(baseManifest({ requiredPermissions: ["skill.execute", "skill.execute"] }))
    ).toThrow(SkillManifestValidationError);
  });

  it("rejects a prototype-pollution field name", () => {
    // `__proto__` as an object-literal key sets the prototype rather than creating an enumerable own
    // property, so it would never reach the validator's Object.keys() scan — use a defineProperty'd
    // own property to actually exercise the forbidden-key check, and a second forbidden key
    // ("constructor") that *is* a normal literal key.
    const withProto: Record<string, unknown> = { ...baseManifest() };
    Object.defineProperty(withProto, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true });
    expect(() => validator.validate(withProto)).toThrow(SkillManifestValidationError);
    expect(() => validator.validate({ ...baseManifest(), constructor: "polluted" })).toThrow(
      SkillManifestValidationError
    );
  });

  it("rejects a non-slug key", () => {
    expect(() => validator.validate(baseManifest({ key: "Not A Slug!" }))).toThrow(SkillManifestValidationError);
  });

  it("rejects a missing required field", () => {
    const manifest = baseManifest() as Record<string, unknown>;
    delete manifest.timeoutMs;
    expect(() => validator.validate(manifest)).toThrow(SkillManifestValidationError);
  });

  it("reports all accumulated errors, not just the first", () => {
    try {
      validator.validate(baseManifest({ version: "bad", visibility: "NOPE" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SkillManifestValidationError);
      const details = (error as SkillManifestValidationError).details;
      expect(details.some((d) => d.includes("version"))).toBe(true);
      expect(details.some((d) => d.includes("visibility"))).toBe(true);
    }
  });
});

describe("semver helpers", () => {
  it("isValidSemver accepts well-formed versions and rejects malformed ones", () => {
    expect(isValidSemver("1.2.3")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("not-a-version")).toBe(false);
  });

  it("versionSatisfies evaluates a constraint against a concrete version", () => {
    expect(versionSatisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(versionSatisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(versionSatisfies("not-a-version", "^1.0.0")).toBe(false);
  });

  it("resolveCompatibleVersion picks the highest version satisfying the constraint", () => {
    expect(resolveCompatibleVersion(["1.0.0", "1.2.0", "1.9.0", "2.0.0"], "^1.0.0")).toBe("1.9.0");
    expect(resolveCompatibleVersion(["1.0.0"], "^2.0.0")).toBeNull();
  });

  it("latestVersion prefers the highest stable (non-prerelease) version", () => {
    expect(latestVersion(["1.0.0", "1.1.0", "2.0.0-beta.1"])).toBe("1.1.0");
    expect(latestVersion([])).toBeNull();
  });

  it("isCompatibleUpgrade requires the same major version and a >= bump", () => {
    expect(isCompatibleUpgrade("1.0.0", "1.2.0")).toBe(true);
    expect(isCompatibleUpgrade("1.5.0", "2.0.0")).toBe(false);
    expect(isCompatibleUpgrade("1.5.0", "1.4.0")).toBe(false);
  });

  it("major extracts the major version number, or null for an invalid version", () => {
    expect(major("3.2.1")).toBe(3);
    expect(major("nope")).toBeNull();
  });
});
