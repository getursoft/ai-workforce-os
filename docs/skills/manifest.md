# Skill Manifest Reference

A `SkillManifest` (`packages/skill-sdk/src/types/manifest.ts`) is the declarative contract a skill
publishes. It is authoritative for adapter *behavior* (input/output shape, required
permissions/capabilities, timeout, retry policy); the `Skill`/`SkillVersion` database rows are
authoritative for marketplace/install *state*. A manifest is validated twice: once by TypeScript at
compile time (the interface below), and again at runtime by `SkillManifestValidator`
(`packages/skill-sdk/src/validate/manifest.validator.ts`) — TypeScript types alone are not trusted,
because a manifest is data, not just code.

## Field reference

| Field | Type | Required | Constraint |
|---|---|---|---|
| `key` | `string` | yes | Stable, slug-like identifier (e.g. `"document-reader"`), never changes across versions. Must match `/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/`. |
| `name` | `string` | yes | Non-blank display name. |
| `description` | `string` | yes | Non-blank. Shown on marketplace cards; also passed (truncated to 500 chars) as the agent tool description in `registerSkillTools()`. |
| `category` | `string` | yes | Non-blank free-text category (e.g. `"Document Processing"`, `"Security"`). Used by `SkillRegistryService.byCategory()`. |
| `version` | `string` | yes | Must be a valid semantic version (`isValidSemver`). See `docs/skills/versioning.md`. |
| `author` | `string` | yes | Non-blank. |
| `visibility` | `SkillVisibility` | yes | One of `"PUBLIC" \| "PRIVATE" \| "ORG_ONLY"`. |
| `supportedMimeTypes` | `string[]` | yes | Array of strings; empty for non-document skills (e.g. text-summarization). Drives `SkillRegistryService.byMimeType()` and the attachment file-routing match in `attachment.service.ts`. |
| `inputSchema` | `Record<string, unknown>` | yes | A JSON Schema, compiled with Ajv. Every `execute()` input is validated against it before `adapter.validate()` runs. |
| `outputSchema` | `Record<string, unknown>` | yes | A JSON Schema. Every `adapter.execute()` result's `.data` is validated against it before being returned. |
| `requiredPermissions` | `SkillPermissionKey[]` | yes | Must be unique; every entry must be one of `SKILL_PERMISSION_KEYS`. |
| `requiredCapabilities` | `SkillCapabilityKey[]` | yes | Must be unique; every entry must be one of `SKILL_CAPABILITY_KEYS`. |
| `dependencies` | `SkillDependencyDeclaration[]` | yes | Array of `{ skillKey, versionConstraint, required }`. Keys must be unique, `skillKey` must match the slug pattern, `versionConstraint` must be a non-blank string. |
| `billingCategory` | `SkillBillingCategory` | yes | One of `"DETERMINISTIC" \| "CPU_INTENSIVE" \| "AI_PROVIDER_BACKED" \| "EXTERNAL_PROVIDER_BACKED" \| "STORAGE_HEAVY"`. `"AI_PROVIDER_BACKED"` triggers the `SKILLS_AI_BACKED` entitlement check at install time. |
| `timeoutMs` | `number` | yes | Between 1 and 300,000 (5 minutes). Enforced both by the validator and by `withTimeout()` in `skill-runtime.service.ts`. |
| `retryPolicy` | `SkillRetryPolicy \| undefined` | no | `{ maxRetries: 0-10, backoffMs: 0-60,000 }`. The runtime additionally clamps `maxRetries` to a hard ceiling of 3 (`MAX_RETRIES` in `skill-runtime.service.ts`) regardless of what the manifest declares. |
| `statefulness` | `SkillStatefulness` | yes | One of `"STATELESS" \| "STATEFUL"`. Declarative only — nothing branches on it in Sprint 6.1. |
| `configurationSchema` | `Record<string, unknown> \| undefined` | no | Optional JSON Schema for org-level configuration (`SkillInstallation.configurationJson`). When present, `SkillInstallationService.install()`/`configure()` require the org to supply configuration matching it. |
| `capabilitySummary` | `string[]` | yes | Human-readable bullet points shown on marketplace cards (e.g. `["Read PDF", "Read Word documents"]`). |
| `releaseNotes` | `string \| undefined` | no | Free text, not currently surfaced anywhere. |

## What `SkillManifestValidator` enforces beyond TypeScript types

`SkillManifestValidator.validate(value)` treats the manifest as untrusted `unknown` input — a
malformed or hostile manifest (e.g. one loaded from a future untrusted source) cannot pass just
because it happens to typecheck. It:

1. **Rejects prototype-pollution keys.** Any top-level key in `__proto__`, `prototype`, or
   `constructor` is an error (`FORBIDDEN_KEYS`, `manifest.validator.ts:11,35`).
2. **Requires every field** in the required-fields list (all fields marked "yes" above) to be
   present on the object at all — a missing field is reported by name, not just "invalid manifest".
3. **Validates the `key` against a slug pattern** (`KEY_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/`) —
   rejects anything that isn't lowercase-alphanumeric with `-`/`.` separators. The same pattern is
   applied to every `dependencies[].skillKey`.
4. **Validates semver**, not just "is a string" — `version` must pass `isValidSemver`.
5. **Enum-checks** `visibility`, `statefulness`, and `billingCategory` against their exact allowed
   value sets (not just "any string").
6. **Bounds-checks numeric fields** — `timeoutMs` in `[1, 300000]`; `retryPolicy.maxRetries` in
   `[0, 10]`; `retryPolicy.backoffMs` in `[0, 60000]`.
7. **Compiles `inputSchema`, `outputSchema`, and (if present) `configurationSchema` with Ajv**
   (`compileSchema()`) — a manifest whose schema is not valid JSON Schema is rejected outright, not
   discovered later at the first execution.
8. **Allowlists `requiredPermissions`/`requiredCapabilities` against the SDK's stable key
   constants** (`SKILL_PERMISSION_KEYS`/`SKILL_CAPABILITY_KEYS`) — an adapter cannot invent a new
   permission or capability string; both arrays must also contain no duplicates.
9. **Validates dependency shape** — each `dependencies[]` entry must have a string `skillKey` and
   string `versionConstraint`; `skillKey`s must be unique within the manifest.
10. **Accumulates every error before throwing** — `SkillManifestValidationError.details` is the full
    list of problems found, not just the first one hit, so a manifest author (or `sync()`'s log
    output) sees everything wrong in one pass.

`SkillManifestValidator` is called in two places: `SkillPublisherService.sync()` (on every app boot,
before a manifest is upserted into the database — see `docs/skills/publishing.md` for what happens
when validation fails) and directly in `skill-sdk-contracts.spec.ts`'s tests.

## A complete real example: the Entity Extraction manifest

Copied faithfully from `apps/api/src/skills-platform/built-in/entity-extraction.skill.ts` (lines
37-86):

```typescript
const MANIFEST: SkillManifest = {
  key: "entity-extraction",
  name: "Entity Extraction",
  description:
    "Extracts structured fields from free text according to a caller-supplied schema. The schema is fully caller-defined — this skill never hardcodes any employee's domain entities.",
  category: "Text Processing",
  version: "1.0.0",
  author: "AI Workforce OS",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text", "entitySchema"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 200_000 },
      entitySchema: {
        type: "object",
        minProperties: 1,
        maxProperties: 50,
        additionalProperties: { enum: ["string", "number", "boolean", "date"] }
      },
      context: { type: "string", maxLength: 2000 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["entities", "confidence", "warnings"],
    properties: {
      entities: { type: "object" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      warnings: { type: "array", items: { type: "string" } }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: ["ai.provider.execute"],
  dependencies: [],
  billingCategory: "AI_PROVIDER_BACKED",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 1, backoffMs: 250 },
  statefulness: "STATELESS",
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      minConfidence: { type: "number", minimum: 0, maximum: 1 }
    }
  },
  capabilitySummary: ["Extract structured fields from text using a caller-defined schema"]
};
```

Note `requiredCapabilities: ["ai.provider.execute"]` with no `requiredPermissions` beyond
`skill.execute` — this skill needs the AI capability handle but does not request any sensitive
capability, so it installs without the `approveSensitivePermissions` flag (see
`docs/skills/security.md`). Its `configurationSchema` is optional org-level tuning
(`minConfidence`), separate from `inputSchema` (the per-call input).
