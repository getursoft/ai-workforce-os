# Skill Runtime

`SkillsRuntimeService` (`apps/api/src/skills-platform/skill-runtime.service.ts`) is the single stable
entry point employees, workflows, and schedulers use to run a skill. Every caller — an agent tool
call, `WorkflowSkillStepService.invoke()`, the scheduler's `RUN_SKILL` handler, the HTTP
`POST /skills/execute` route, `attachment.service.ts`'s file routing — ultimately calls
`SkillsRuntimeService.execute()`. There is no second path that bypasses these checks.

## `execute()` flow, step by step

```
execute(request: SkillExecuteRequest)
  │
  ├─ 1. Idempotency replay check — findReplay()
  │     Look up a SkillRun by (organizationId, skillKey, idempotencyKey). If one exists and its
  │     status is COMPLETED, return its persisted output directly (status: "REPLAY") without
  │     touching the adapter at all. If one exists but is NOT completed, throw SKILL_RUN_REPLAY
  │     (a concurrent/retried execution is already in flight for this key).
  │
  ├─ 2. Resolve adapter — resolveAdapter()
  │     SkillRegistryService.resolveByConstraint(skillKey, versionConstraint). Throws
  │     SKILL_VERSION_NOT_FOUND if no registered adapter matches.
  │
  ├─ 3. Assert installation — assertInstallation()
  │     SkillInstallation lookup scoped to (organizationId, skillKey, version), deletedAt: null.
  │     Throws SKILL_NOT_INSTALLED if absent, SKILL_DISABLED if installed but installation.enabled
  │     is false.
  │
  ├─ 4. Assert monthly execution limit — assertMonthlyExecutionLimit()
  │     Counts SkillRun rows created since the start of the current UTC calendar month for this
  │     org and compares against the SKILLS_EXECUTION_MONTHLY_LIMIT entitlement. Throws
  │     SKILL_LIMIT_REACHED once the count reaches the limit. This is a rolling count against
  │     SkillRun itself, not a separate ledger, so it can never drift from reality.
  │
  ├─ 5. Assert employee grant — assertEmployeeGrant() (only when pluginInstallationId is supplied)
  │     EmployeeSkillGrant lookup scoped to (organizationId, pluginInstallationId,
  │     skillInstallationId, enabled: true). Throws SKILL_EMPLOYEE_GRANT_DENIED if absent/disabled.
  │     Skipped entirely for callers that don't pass a pluginInstallationId (e.g. an org-level
  │     scheduled job with no employee context).
  │
  ├─ 6. Resolve dependencies — resolveDependencies()
  │     For every required entry in manifest.dependencies, confirms an enabled, PUBLISHED
  │     installation of that dependency skill exists for this org and its version satisfies the
  │     declared constraint. Throws SKILL_DEPENDENCY_MISSING or SKILL_DEPENDENCY_VERSION_CONFLICT.
  │
  ├─ 7. Build least-privilege context — buildContext()
  │     Merges org-level SkillInstallation.configurationJson with the employee's
  │     EmployeeSkillGrant.configurationOverrideJson (override wins), reads org locale/timezone,
  │     and calls buildSkillCapabilities() to construct the SkillExecutionContext.capabilities
  │     handle from manifest.requiredCapabilities. See docs/skills/security.md.
  │
  ├─ 8. Open a SKILL_EXECUTION trace span — traced()
  │     Wraps everything below in ObservabilityService.withSpan() when available (falls through to
  │     a plain callback call when ObservabilityService is not injected, e.g. in unit tests).
  │
  ├─ executeResolved() — inside the span:
  │   │
  │   ├─ 9. Create the SkillRun row (status RUNNING), with a truncated inputSummaryJson
  │   │      (4KB cap) — never the raw input beyond that cap.
  │   │
  │   ├─ 10. Validate input schema — validateSchema(manifest.inputSchema, request.input)
  │   │       Ajv-compiled and cached per "key@version:input". Throws SKILL_INPUT_INVALID.
  │   │
  │   ├─ 11. adapter.validate(input, context) — the adapter's own domain-rule validation beyond
  │   │       JSON Schema (e.g. entity-extraction rejects an unsupported declared entity type).
  │   │
  │   ├─ 12. adapter.execute(input, context) with timeout + retry
  │   │       Wrapped in withTimeout(manifest.timeoutMs ?? 30_000) — throws SKILL_TIMEOUT past the
  │   │       deadline. On a thrown error, retries up to min(manifest.retryPolicy.maxRetries, 3)
  │   │       times with exponential backoff (retryPolicy.backoffMs * 2^attempt), then re-throws
  │   │       the last error once retries are exhausted.
  │   │
  │   ├─ 13. Validate output schema — validateSchema(manifest.outputSchema, result.data)
  │   │       Throws SKILL_OUTPUT_INVALID — a normalized-but-wrong result is rejected just as
  │   │       strictly as a malformed input.
  │   │
  │   ├─ 14. Compute usage/credits
  │   │       Uses result.usage if the adapter reported it, else estimates tokens from
  │   │       JSON-stringified length / 4. tokensToCredits(totalTokens) converts to billed credits
  │   │       (same formula agent executions use).
  │   │
  │   ├─ 15. Persist the SkillRun as COMPLETED — outputSummaryJson (64KB cap, truncated beyond
  │   │       that), durationMs, token counts, creditsConsumed, retryCount.
  │   │
  │   ├─ 16. Record a UsageEvent — usageType: "SKILL_EXECUTION", idempotencyKey
  │   │       "skill-run:<idempotencyKey>". Failure here is caught and logged, never thrown — a
  │   │       usage record must not fail an otherwise-successful execution.
  │   │
  │   ├─ 17. Record an audit event — SKILL_EXECUTION_COMPLETED (or SKILL_EXECUTION_FAILED on the
  │   │       catch path below), including creditsConsumed and (on failure) errorCode.
  │   │
  │   └─ 18. Return SkillExecuteResult { skillKey, skillVersion, runId, status: "COMPLETED", data,
  │           usage, creditsConsumed, durationMs, warnings?, retryCount }.
  │
  └─ On any thrown error at steps 10-13: persist the SkillRun as FAILED with a safe error
     code/message (safeSkillErrorCode/safeSkillErrorMessage — never the raw provider output or
     document content), record SKILL_EXECUTION_FAILED, and re-throw (a SkillError as-is, anything
     else wrapped in one).
```

Two other public methods on the same service:

- **`skillsForEmployee(organizationId, pluginInstallationId)`** — capability discovery. Returns only
  skills that are both granted (`EmployeeSkillGrant.enabled: true`) *and* whose installation is
  enabled and not soft-deleted. This is what `AgentService`'s per-turn tool availability set is built
  from (`docs/skills/security.md`), and what `attachment.service.ts` checks before routing a file
  through Document Reader.
- **`executions(organizationId, skillInstallationId, page)`** — paginated execution history for the
  dashboard's Executions tab. **Deliberately strips `inputSummaryJson`/`outputSummaryJson`** from the
  `select` — the code comment at `skill-runtime.service.ts:175-178` states this is intentional:
  execution history must never surface raw document content the skill processed, only safe
  status/usage/billing metadata (`id`, `skillKey`, `skillVersion`, `status`, `durationMs`, token
  counts, `creditsConsumed`, `retryCount`, `errorCode`, `errorMessageSafe`, timestamps, `traceId`,
  and the linking IDs). There is no endpoint that returns a `SkillRun`'s summary JSON.
- **`checkHealth(organizationId, skillInstallationId)`** — resolves the adapter and calls its
  `health(context)`, used by the dashboard's Health tab and `GET /skills/installations/:id/health`.

## `SkillErrorCode` reference

Source of truth: `apps/api/src/skills-platform/skill-error.ts`. Every code maps to a stable HTTP
exception via `toSkillHttpError()`, used by the controller's catch blocks.

| Code | HTTP | Thrown when |
|---|---|---|
| `SKILL_NOT_FOUND` | 404 | (Reserved for skill-key-level lookups; not currently thrown by the runtime/installation services shown here — they throw the more specific codes below.) |
| `SKILL_VERSION_NOT_FOUND` | 404 | No registered adapter matches the requested key/version constraint (`resolveAdapter`), or `resolvePublishedVersion` finds no matching published `SkillVersion`, or a version constraint doesn't match the resolved adapter's actual version. |
| `SKILL_NOT_INSTALLED` | 404 | No `SkillInstallation` row exists for this org/skill/version (`assertInstallation`, `getInstallation`). |
| `SKILL_ALREADY_INSTALLED` | 409 | `install()` called for a skill version the org already has an active installation of. |
| `SKILL_DISABLED` | 409 | Installation exists but `enabled: false` (`assertInstallation`). |
| `SKILL_EMPLOYEE_GRANT_DENIED` | 403 | No enabled `EmployeeSkillGrant` links this employee to this installation (`assertEmployeeGrant`), or `revokeFromEmployee`/`setEmployeeGrantEnabled` target a grant that doesn't exist. |
| `SKILL_EMPLOYEE_NOT_FOUND` | 404 | `grantToEmployee` targets a `Plugin` (employee installation) that doesn't exist in this org. |
| `SKILL_ORGANIZATION_DENIED` | 403 | A capability handle is invoked with an `organizationId` that doesn't match the calling context's — see `buildSkillCapabilities`'s `object.read` check. Tenant-isolation defense inside a capability handle itself. |
| `SKILL_ENTITLEMENT_DENIED` | 403 | A capability was requested by the manifest but the underlying service isn't available at runtime (e.g. `ai.provider.execute` with no `PluginAiService`, or no `pluginInstallationId` in context), or `knowledge.read` is invoked (declared but unimplemented — always throws this). |
| `SKILL_LIMIT_REACHED` | 409 | `SKILLS_EXECUTION_MONTHLY_LIMIT` exceeded (runtime), or `SKILLS_MAX_PER_EMPLOYEE` exceeded (installation service, granting). |
| `SKILL_DEPENDENCY_MISSING` | 409 | A required `manifest.dependencies` entry has no matching enabled/published installation. |
| `SKILL_DEPENDENCY_VERSION_CONFLICT` | 409 | A required dependency is installed but its version doesn't satisfy the declared constraint; also thrown by `updateVersion()` when the target version isn't a same-major compatible upgrade. |
| `SKILL_DEPENDENCY_CYCLE` | 409 | Declared in the error-code union and mapped to HTTP, but **not currently thrown anywhere in the codebase** — see `docs/skills/security.md` for why dependency cycles are prevented structurally rather than detected. |
| `SKILL_INPUT_INVALID` | 400 | Input fails the manifest's `inputSchema` Ajv validation, or an adapter's own `validate()` rejects it. |
| `SKILL_OUTPUT_INVALID` | 422 | The adapter's result fails the manifest's `outputSchema` Ajv validation. |
| `SKILL_TIMEOUT` | 408 | `adapter.execute()` didn't resolve within `manifest.timeoutMs` (default 30s), after retries are exhausted. |
| `SKILL_PAYLOAD_TOO_LARGE` | 400 | An adapter-level size check fails (e.g. Document Reader's 50MB buffer cap). |
| `SKILL_INSTALLATION_STATE_CONFLICT` | 409 | `updateVersion()` targeting the already-installed version, or `rollbackVersion()` with no `previousSkillVersionId` recorded. |
| `SKILL_INVALID_CONFIGURATION` | 400 | Configuration fails `manifest.configurationSchema` Ajv validation, is required but missing, exceeds the 16KB size cap, or a `migrate()` installer hook throws during `updateVersion()`. |
| `SKILL_SENSITIVE_PERMISSION_REQUIRED` | 403 | Install requests a capability in `SENSITIVE_CAPABILITY_KEYS` without `approveSensitivePermissions: true`. |
| `SKILL_RUN_REPLAY` | 409 | A `SkillRun` with this idempotency key exists but hasn't reached `COMPLETED` yet — a concurrent execution is in flight. |
| `SKILL_INTERNAL_ERROR` | 422 | Catch-all for unexpected states (e.g. a manifest that fails to parse from `SkillVersion.manifestJson`, a schema that fails to compile, or `withTimeout`'s internal fallback). Also what `SkillRegistryService.register()` throws on a `key@version` collision. |

## Timeout and retry mechanics

`withTimeout()` (exported from `skill-runtime.service.ts`) races the adapter's promise against a
`setTimeout` that rejects with `SkillError("SKILL_TIMEOUT")`. The retry loop in `executeResolved()`
runs *around* that timeout race — each retry attempt gets its own fresh `manifest.timeoutMs` window,
and `retryCount` is incremented per attempt regardless of whether the failure was a timeout or any
other thrown error. `maxRetries` is `Math.min(manifest.retryPolicy?.maxRetries ?? 0, 3)` — a manifest
cannot request more than 3 retries even if its own `retryPolicy.maxRetries` field (bounds-checked to
10 by the manifest validator) says otherwise; the runtime's `MAX_RETRIES` constant is the real
ceiling.

## Idempotency

Every `SkillExecuteRequest` carries (or is assigned) an `idempotencyKey`. If a caller omits one, the
runtime generates `skill:<skillKey>:<crypto.randomUUID()>` — effectively "no replay protection for
this call" unless the caller supplies its own key. Callers that need replay safety supply a
deterministic key: the scheduler uses `scheduler:<context.executionId>` so a retried job execution
replays the prior result instead of re-running (and re-billing) the skill. `SkillRun` has a unique
constraint on `(organizationId, idempotencyKey)` at the database level (`schema.prisma:3553`), so a
race between two concurrent calls with the same key cannot both create a row — one will observe
`findReplay()`'s in-progress state first (`SKILL_RUN_REPLAY`) or the unique constraint itself will
reject the second insert.
