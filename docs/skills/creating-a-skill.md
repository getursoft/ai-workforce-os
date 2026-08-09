# Creating a Built-in Skill

A practical how-to for adding a 6th built-in skill adapter. This describes the process the existing
five skills actually follow — nothing here is aspirational. As of Sprint 6.1, only built-in,
in-process skills are supported; see `docs/skills/publishing.md` for why third-party skill packages
are explicitly out of scope.

## Steps

### (a) Define a `SkillManifest`

Pick a stable, slug-like `key` (lowercase, `-`/`.` separators — see `KEY_PATTERN` in
`docs/skills/manifest.md`) that never changes across versions. Write real JSON Schemas for
`inputSchema`/`outputSchema` — `additionalProperties: false` on input schemas is the existing
convention (every built-in skill uses it) so unexpected fields are rejected rather than silently
ignored. Only declare `requiredPermissions`/`requiredCapabilities` from the SDK's stable key sets
(`SKILL_PERMISSION_KEYS`/`SKILL_CAPABILITY_KEYS`) — the manifest validator rejects anything else. If
your skill needs a sensitive capability (`SENSITIVE_CAPABILITY_KEYS` — `object.write`,
`knowledge.write`, `memory.read`, `email.send`, `channel.send`, `network.external`), know that
installing it will require an administrator to pass `approveSensitivePermissions: true`.

### (b) Implement `SkillAdapter`'s `validate`/`execute`/`health`

- `validate(input, context)` — domain-rule checks beyond what JSON Schema can express. Must not
  mutate state. Throw `SkillError("SKILL_INPUT_INVALID", "...")` on rejection.
- `execute(input, context)` — the actual work. Read tenant state *only* through
  `context.capabilities.*` handles (never inject Prisma into a skill adapter). Return
  `{ data, usage?, warnings? }`; `data` will be validated against `outputSchema` before the runtime
  returns it, so it must conform exactly.
- `health(context)` — use the SDK's builders (`healthySkillHealth`, `degradedSkillHealth`,
  `unhealthySkillHealth`, `unknownSkillHealth`) rather than hand-rolling the envelope.

If your skill depends on an AI provider, follow the existing pattern: try
`context.capabilities.ai.complete(...)` when granted, and degrade gracefully (never throw) when it's
absent or fails — see `docs/skills/built-in-skills.md` for how text-summarization, entity-extraction,
and translation each do this differently.

### (c) Optionally implement `SkillInstaller` hooks

If your skill needs setup/teardown work at install/uninstall/enable/disable time, or configuration
migration across versions, implement `SkillInstaller` (`install?`, `uninstall?`, `enable?`,
`disable?`, `migrate?`, `health?`) and expose it as `readonly installer = { ... }` on your adapter
class. `SkillInstallationService` calls these hooks automatically via `installerOf(adapter)` — you
don't wire them up yourself beyond defining them. None of the five current built-in skills define an
installer; it's genuinely optional.

### (d) Register the provider

Add the adapter class to `SkillPlatformModule`'s `providers` array and export list if other modules
need it, and add it to `SkillPlatformBootstrapService`'s constructor + `onApplicationBootstrap()`
registration list in `apps/api/src/skills-platform/skill-platform.module.ts`:

```typescript
constructor(
  private readonly registry: SkillRegistryService,
  private readonly publisher: SkillPublisherService,
  private readonly documentReader: DocumentReaderSkill,
  // ...existing skills...
  private readonly yourNewSkill: YourNewSkill   // add here
) {}

async onApplicationBootstrap(): Promise<void> {
  this.registry.register(this.documentReader);
  // ...existing skills...
  this.registry.register(this.yourNewSkill);   // add here
  ...
}
```

Also add `YourNewSkill` to the module's `providers` array alongside the other four adapter classes.

### (e) It auto-syncs into the database on next boot

You do not manually insert `Skill`/`SkillVersion` rows. `SkillPublisherService.sync()` runs on every
`onApplicationBootstrap()` and upserts your manifest automatically (`docs/skills/publishing.md`). If
your manifest fails `SkillManifestValidator.validate()`, it is logged and skipped — the app still
boots, but your skill won't appear in the marketplace until the manifest is fixed and the process
restarts. Check the boot log for `SKILL_MANIFEST_REJECTED`/`SKILL_PUBLICATION_PARTIAL` if it doesn't
show up.

### (f) Write tests following the existing pattern

`apps/api/src/skills-platform/built-in/entity-extraction.skill.spec.ts` is the reference test file.
Its structure:

```typescript
describe("EntityExtractionSkill", () => {
  it("rejects empty text", async () => { ... });
  it("rejects an empty entitySchema", async () => { ... });
  it("rejects an unsupported declared entity type", async () => { ... });
  it("extracts entities using the AI capability when granted, parsing structured JSON output", async () => { ... });
  it("only fills fields declared in the schema, never inventing extra fields from a noisy AI response", async () => { ... });
  it("falls back to deterministic best-effort extraction when no AI capability is granted", async () => { ... });
  it("falls back to deterministic extraction when the AI provider throws, without failing the turn", async () => { ... });
  it("health reports HEALTHY", async () => { ... });
});
```

At minimum, cover: `validate()` rejection cases, a successful `execute()` path, the AI-vs-fallback
branch if applicable (both directions — capability present and absent — plus the provider-throws
case), and `health()`. Construct a `SkillExecutionContext` by hand in the test rather than going
through the full runtime — the existing spec files build a minimal fake context object with only the
fields the adapter under test actually reads (e.g. `capabilities.ai.complete` as a `vi.fn()`).

## Minimal worked skeleton

A trimmed-down version of `file-validation.skill.ts`'s structure (that skill has no capabilities and
no AI dependency, making it the simplest adapter to model a new one on):

```typescript
import { Injectable } from "@nestjs/common";
import type {
  SkillAdapter,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillHealthResult,
  SkillManifest
} from "@ai-workforce-os/skill-sdk";
import { healthySkillHealth } from "@ai-workforce-os/skill-sdk";
import { SkillError } from "../skill-error";

export interface ExampleSkillInput {
  value: string;
}

export interface ExampleSkillOutput {
  result: string;
  warnings: string[];
}

const MANIFEST: SkillManifest = {
  key: "example-skill",
  name: "Example Skill",
  description: "Describe exactly what this skill does and does not do.",
  category: "Text Processing",
  version: "1.0.0",
  author: "AI Workforce OS",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
      value: { type: "string", minLength: 1, maxLength: 10_000 }
    }
  },
  outputSchema: {
    type: "object",
    required: ["result", "warnings"],
    properties: {
      result: { type: "string" },
      warnings: { type: "array", items: { type: "string" } }
    }
  },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: [],
  dependencies: [],
  billingCategory: "DETERMINISTIC",
  timeoutMs: 15_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0 },
  statefulness: "STATELESS",
  capabilitySummary: ["Describe the capability in one short phrase"]
};

@Injectable()
export class ExampleSkill implements SkillAdapter<ExampleSkillInput, ExampleSkillOutput> {
  readonly manifest = MANIFEST;

  async validate(input: ExampleSkillInput): Promise<void> {
    if (!input.value?.trim()) throw new SkillError("SKILL_INPUT_INVALID", "value is required");
  }

  async execute(
    input: ExampleSkillInput,
    _context: SkillExecutionContext
  ): Promise<SkillExecutionResult<ExampleSkillOutput>> {
    return {
      data: { result: input.value.toUpperCase(), warnings: [] }
    };
  }

  async health(): Promise<SkillHealthResult> {
    return healthySkillHealth([{ name: "adapter-registered", status: "HEALTHY" }]);
  }
}
```

Then:

1. Register `ExampleSkill` in `SkillPlatformModule`'s `providers` and inject it into
   `SkillPlatformBootstrapService`, adding `this.registry.register(this.exampleSkill);`.
2. Write `example.skill.spec.ts` covering `validate()` rejection and the happy `execute()` path.
3. Restart the app — `SkillPublisherService.sync()` publishes `example-skill@1.0.0` automatically,
   and it appears in `GET /skills/marketplace` for any org to install.

Nothing beyond this is required to make a new built-in skill available — there is no separate
registration file, no manual database migration for the skill's own metadata (the `Skill`/
`SkillVersion` tables themselves are already migrated by Sprint 6.1's Prisma migration), and no
manual marketplace listing step.
