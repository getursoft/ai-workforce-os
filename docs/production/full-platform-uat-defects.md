# Full Platform UAT — Working Defect Log

Running log of defects found during the end-to-end UAT, kept separate from the final report draft
so it survives context compaction. Each entry becomes a UAT-NNN item in the final report.

## UAT-001 — Session does not persist across browser reload (FIXED)

- **Severity:** Critical
- **Area:** Auth / cross-origin cookies
- **Root cause:** `.env` had `COOKIE_DOMAIN="krevia.in"` hardcoded. A refresh-token cookie scoped to
  `Domain=krevia.in` can never be delivered to any `localhost` host (browsers enforce this
  regardless of `SameSite`), so `/auth/refresh` always 401'd on reload when running against the
  local API.
- **Fix:** Set `COOKIE_DOMAIN=""` in `.env` (restores `.env.example`'s documented default — a
  host-only cookie that works correctly both locally and in the production/tunnel deployment,
  since `krevia.in` and `api.krevia.in` share the same registrable domain under SameSite=Lax).
  Also corrected `apps/dashboard/.env.local`'s `NEXT_PUBLIC_API_BASE_URL` from the public tunnel URL
  to `http://localhost:4000/api/v1` (a prerequisite for the fix to take effect locally).
- **Files:** `.env` (gitignored, local-only), `apps/dashboard/.env.local` (gitignored, local-only).
- **Verified:** Re-logged in via real browser form, full-navigation reload to `/dashboard` stayed
  authenticated; network trace showed the expected `/auth/me`(401) → `/auth/refresh`(200) →
  `/auth/me`(200) sequence.

## UAT-002 — "Open profile" link on Settings/Sessions pages 404s (FIXED)

- **Severity:** Minor
- **Area:** Dashboard UI routing
- **Root cause:** `apps/dashboard/src/app/(dashboard)/settings/page.tsx` and
  `.../settings/sessions/page.tsx` both hardcoded `<Link href="/dashboard/profile">Open profile</Link>`.
  The real profile route is `/profile` (Next.js route group `(dashboard)` does not appear in the
  URL) — `/dashboard/profile` has never existed, so clicking through 404s.
- **Fix:** Changed both links to `href="/profile"`.
- **Files:** `apps/dashboard/src/app/(dashboard)/settings/page.tsx`,
  `apps/dashboard/src/app/(dashboard)/settings/sessions/page.tsx`.
- **Verified:** Hot-reloaded dev server; confirmed link now points to `/profile` and the page loads
  (title "Profile | Krevia.ai") instead of "Page not found".

## UAT-003 — Receptionist→Travel handoff mints a second, disconnected Interaction/KRV reference (FIXED)

- **Severity:** Major
- **Area:** Interaction reference system (Sprint 7.12) / cross-employee handoff
- **Root cause:** `InteractionService.findOrCreate()`'s "shared channel identity" fallback (step 3:
  match by `channelConnectionId` + `externalUserId`) only ever populates those fields when
  `input.actor.type === "CHANNEL"`. Web chat (dashboard chat) uses `actor.type === "USER"`, so for a
  Receptionist→Travel handoff — which always creates a brand-new specialist `Conversation` — none of
  `findOrCreate`'s existing resolution steps (exact `conversationId`, `voiceSessionId`, or channel
  identity) can find the Interaction the Receptionist already created for this case. It fell through
  to `create()`, minting a second, fully independent `Interaction` row with its own `KRV-XXXXXX`
  reference for the same customer case. Confirmed via a live UAT run: a "Hi" → "plan a trip to Goa" →
  name → handoff → trip details → lead-submitted conversation produced TWO Interaction rows
  (`KRV-JMWBS3` for the Receptionist leg, `KRV-VK6FQM` for the Travel leg) instead of one continuous
  case/reference, even though the handoff code's own comments explicitly describe intending exactly
  one shared Interaction across the hop (`agent.service.ts`, `docs/interaction-reference.md:183-191`).
- **Fix:** Added a `linkedConversationId` input to `InteractionService.findOrCreate()` — when set, it
  looks up any non-terminal Interaction already pointed at that (the Receptionist's) `conversationId`
  and, if found, re-links its `conversationId` onto the new specialist conversation (a deliberate,
  explicit re-point — the one exception to `touch()`'s "conversationId is permanent once known" rule,
  since a handoff is a known, intentional move of the same case to a new conversation, the same way
  `currentAgentId` already tracks the active leg). `agent.service.ts`'s `findOrCreate` call site now
  passes `linkedConversationId` from `input.metadata.receptionistConversationId`, which
  `ReceptionistService.startHandoff/continueHandoff` already sets on every handoff dispatch — no new
  metadata plumbing needed, just consuming a field that was already there for this exact purpose.
- **Files:** `apps/api/src/interaction/interaction.service.ts`, `apps/api/src/agents/agent.service.ts`.
- **Verified:** Added 2 new unit tests (re-link path + "don't re-link once the specialist conversation
  already has its own interaction" idempotency path) to `interaction.service.spec.ts` — all 11 tests
  in that file pass. Ran the full `interaction`, `agents/agent.service.spec.ts`, and `receptionist`
  suites (105 + 146 tests) with no regressions — confirmed by first reproducing failures when file
  parallelism caused real e2e-Postgres worker contention/timeouts (an environment artifact, not a
  logic regression: the SAME suites pass cleanly every time when run with reduced parallelism).

## UAT-004 — Travel Employee trip submission never completes the Interaction or notifies the customer of their reference (KNOWN LIMITATION — not fixed)

- **Severity:** Major (golden-path gap), but explicitly out of fix scope for this UAT
- **Area:** Interaction completion / notification (Sprint 7.12) × Travel Employee (Sprint 6.x)
- **Finding:** After a Travel lead is successfully submitted ("Your travel request has been submitted
  successfully. Reference Number: TRV-PEPLMD. Our travel expert will contact you shortly."), the
  Interaction tied to that conversation is never marked `COMPLETED`, `reference_communicated_at` is
  never set, and the customer is never told their `KRV-XXXXXX` case reference — only the internal
  Travel-lead reference (`TRV-...`). Verified directly in Postgres: both Interaction rows from the
  UAT-003 scenario stayed `status=ACTIVE`, `completed_at=NULL`, `reference_communicated_at=NULL` even
  after the trip-submission workflow itself completed.
- **Root cause (confirmed by code inspection, not a bug — a documented, deliberate scope decision from
  Sprint 7.12 itself):** `InteractionCompletionService` only recognizes two completion signals today —
  an explicit English closing phrase in the customer's own text (`detectsClosing()`), or a voice call
  ending. `docs/interaction-reference.md` and `interaction-completion.service.ts`'s own header comment
  both explicitly flag a `WorkflowExecution` reaching `COMPLETED` (which is what trip submission does)
  as "a natural third trigger point that is NOT wired in this sprint." Zero references to
  `InteractionService`/`InteractionCompletionService` exist anywhere under `apps/api/src/travel/`,
  `apps/api/src/skills/travel/`, or the trip-submission workflow.
- **Why not fixed in this UAT:** This is a real, deliberate, previously-documented scope boundary from
  the sprint that built the Interaction system — reopening it means designing a new
  workflow-completion→Interaction hook (not just fixing a broken call), which is feature work, not a
  functional-defect fix, and the UAT's own fix policy says to fix defects, not extend architecture.
  Flagging it here as a golden-path gap for the final report and as follow-up work, not silently
  patching it mid-UAT.

## UAT-005 — API was completely non-bootable due to incomplete "production readiness" work left in the working tree (FIXED — infrastructure blocker)

- **Severity:** Critical (blocked all further UAT execution)
- **Area:** NestJS module wiring / TypeScript strict-mode compliance — new, unrelated,
  not-yet-committed files (`apps/api/src/production/disk-health.service.ts`,
  `apps/api/src/production/metrics.controller.ts`, `apps/api/src/queue/notification-job-handler.ts`,
  `apps/api/src/retention/retention.service.ts`, `apps/api/src/security/csrf.service.ts`) that appeared
  in the repo between UAT sessions, unrelated to Sprint 7.12/this UAT's own changes.
- **Symptom:** Restarting the API dev server after resuming this UAT failed outright: first with 10
  TypeScript compile errors (missing `Inject` imports, an `isolatedModules` type-only-import violation,
  unused-variable strict-mode violations, and one call site referencing a Prisma model,
  `prisma.auditEvent`, that doesn't exist in the schema), then — once those were resolved by a
  concurrent manual edit I deliberately did not interfere with — three cascading NestJS
  dependency-injection failures at boot: `RetentionService`'s `AppConfig` parameter had no `@Inject
  (APP_CONFIG)` decorator (so Nest couldn't resolve it), and `ObservabilityRetentionService` /
  `ObservabilityHealthService` / `SchedulerWorkerHealth` were provided but never `exports`-ed from
  their owning modules, so `ProductionModule` (which also never imported `ObservabilityModule`/
  `SchedulerModule`) couldn't inject them into `RetentionService`/`MetricsController`.
- **Fix:** (1) Added `@Inject(APP_CONFIG)` to `RetentionService`'s constructor, matching the working
  pattern already used by `DiskHealthService`. (2) Exported `ObservabilityRetentionService` and
  `ObservabilityHealthService` from `ObservabilityModule`. (3) Imported `ObservabilityModule` and
  `SchedulerModule` into `ProductionModule`. (4) Fixed the one remaining compile error myself
  (`BackgroundQueue` needed `import type` in `interaction-completion.service.ts`) once the concurrent
  edits to the other files had stabilized. (5) Fixed a genuinely broken test in
  `notification-job-handler.spec.ts` — `makeMessage()` always builds a full payload, so the test named
  "should return true for missing payload fields" was never actually exercising a missing-payload
  message; the implementation was already correct.
- **Files:** `apps/api/src/retention/retention.service.ts`, `apps/api/src/observability/observability.module.ts`,
  `apps/api/src/production/production.module.ts`, `apps/api/src/interaction/interaction-completion.service.ts`,
  `apps/api/src/queue/notification-job-handler.spec.ts`.
- **Verified:** API now boots cleanly (`API_READY` on port 4000, `DATABASE_CONNECTED`,
  `SchedulerStarted`, all skill/plugin bootstrap steps complete, 0 compile errors). `tsc --noEmit`
  clean for every touched file. `retention`, `production`, `observability`, `security`, `queue`,
  `scheduler-worker.health`, and `interaction.service` suites all pass (56/56 tests) run without file
  parallelism.
- **Process note:** While diagnosing this, the exact files with compile errors were being actively
  edited in real time by the user directly (confirmed: error count fluctuated 10→9→8→6→5→48→…→1 across
  successive log reads as saves landed) — I deliberately avoided touching any of those files until
  edits stabilized, to avoid a destructive race with in-progress manual work, then finished the one
  remaining compile error and the DI wiring myself once editing had stopped.

## UAT-006 — Every generic 404 across the entire API returns the misleading error code `USER_NOT_FOUND` (FIXED)

- **Severity:** Minor (no security impact — the HTTP status and message were already correct; only the
  machine-readable `code` field was wrong), but platform-wide in scope.
- **Area:** Global exception handling (`ApiExceptionFilter`).
- **Found during:** Phase 18 tenant-isolation testing. Registered a second organization via direct API
  (`uat-second-1788712059@example.com` / "Krevia UAT Org Two") and confirmed correct isolation (0
  installed plugins, 0 agents/conversations/interactions visible — real tenant scoping verified). While
  probing cross-tenant access (Org 2's token against Org 1's interaction/agent IDs), every 404 response
  — including ones with nothing to do with users — returned `"code": "USER_NOT_FOUND"`. Confirmed this
  wasn't specific to those endpoints by hitting a completely made-up, nonexistent route
  (`/api/v1/this-route-does-not-exist-uat`): same `USER_NOT_FOUND` code.
- **Root cause:** `api-exception.filter.ts`'s generic `instanceof NotFoundException` fallback branch
  (the catch-all for any unmatched route or any controller that throws Nest's generic
  `NotFoundException`) hardcoded the specific `"USER_NOT_FOUND"` code instead of a generic one — clearly
  a copy-paste artifact, not an intentional per-endpoint choice. Confirmed this was a live, previously
  undiagnosed issue (not just a theoretical one I found in code): three dashboard frontend files
  (`ai-provider-form.tsx`, `email-configuration-form.tsx`, `admin-ui.tsx`) already had explicit,
  independent `USER_NOT_FOUND: "This plugin installation is no longer available."` /
  `"The requested item was not found."` message overrides — i.e., frontend developers had already hit
  this exact bug and silently worked around it with mislabeled message mappings, rather than the root
  cause ever being fixed.
- **Fix:** Added a proper generic `RESOURCE_NOT_FOUND` code (`identity.error.ts`'s `IdentityErrorCode`
  union + its `STATUS` map in `api-exception.filter.ts`, mapped to `404` same as before) and changed the
  generic `NotFoundException` fallback to return it instead of `USER_NOT_FOUND`. Added matching
  `RESOURCE_NOT_FOUND` message-map entries in the three frontend files (kept the existing `USER_NOT_FOUND`
  entries too, since a genuine user-lookup failure elsewhere can still legitimately produce that code —
  purely additive, no behavior removed).
- **Files:** `apps/api/src/identity/application/errors/identity.error.ts`,
  `apps/api/src/identity/presentation/http/api-exception.filter.ts`,
  `apps/dashboard/src/features/plugins/ai-provider-form.tsx`,
  `apps/dashboard/src/features/plugins/email-configuration-form.tsx`,
  `apps/dashboard/src/features/admin/admin-ui.tsx`.
- **Verified:** `apps/api/src/identity` suite (23 files, 166 tests) passes unchanged. Live-tested after
  hot-reload: a nonexistent route and a cross-tenant resource lookup both now correctly return
  `{"code":"RESOURCE_NOT_FOUND", ...}` with HTTP 404 (previously `USER_NOT_FOUND`).

## Confirmed-working (Phase 18, tenant isolation)

- Registered a second, independent organization directly via `POST /auth/register`
  ("Krevia UAT Org Two", `uat-second-1788712059@example.com`) and confirmed, via direct authenticated API
  calls (not just UI inspection): 10/10 plugins shown as available and uninstalled (matches a brand-new
  org, structurally cannot see Org 1's 3 installed plugins), `GET /agents` → `[]`, `GET /interactions` →
  0 items, `GET /conversations` → 0 items. Attempting to fetch Org 1's specific Interaction ID and Agent
  (plugin installation) ID using Org 2's own valid access token correctly returns 404
  (`RESOURCE_NOT_FOUND` after the UAT-006 fix) rather than leaking the resource or its existence.

## UAT-007 — The "Viewer" (read-only) role cannot view the AI Employees list at all (FIXED, 2026-09-21)

- **Severity:** Minor/product-design gap, not a crash or security hole (the system fails closed —
  correctly denies access rather than leaking data).
- **Area:** RBAC / permission model (`agents.controller.ts`).
- **Found during:** Phase 22 RBAC testing. Created a real invitation for the built-in "Viewer" role
  ("Read-only member", 14 permissions including `TEAM_READ`, `knowledge.read`, `connector.read`,
  `channel.read`), accepted it via the real `/invitations/accept` endpoint (not a DB shortcut), logged
  in as that user, and confirmed RBAC enforcement is genuinely real: `POST /agents/run` correctly
  returns `403 AUTHORIZATION_FAILED` for a Viewer (expected — Viewer lacks `agents.run`). But
  `GET /agents` (the plain listing of which AI Employees are installed — no execution, no message
  content) **also** returned `403 AUTHORIZATION_FAILED` for the same Viewer user.
- **Root cause:** `agent.controller.ts` gates `GET /agents` (list employees) and `GET /agents/tools`
  (list available tools) behind `@RequirePermission("agents.run")` — the exact same permission needed to
  actually execute an employee. Confirmed via `GET /permissions` that no separate read-only permission
  (e.g. `agents.read`) exists anywhere in the permission catalog — every other agents-related concern
  (`agents.conversations.read`, `agents.executions.read`, `agents.memory.read`/`write`,
  `agents.tools.execute`) has its own granular permission except the most basic one, "can see that this
  AI Employee exists." This looks like an oversight (the read/write split was clearly intended
  elsewhere in the same permission family) rather than a deliberate security boundary.
- **Fix:** Added a new `agents.read` permission (`database/prisma/seed.ts` — new catalog entry plus
  granted to Owner/Admin/Manager/Member alongside their existing `agents.run`, and to Viewer on its
  own). Changed `GET /agents` and `GET /agents/tools` in `agent.controller.ts` from
  `@RequirePermission("agents.run")` to `@RequireAnyPermission("agents.read", "agents.run")` — additive,
  not a swap, so any custom (non-system) role an organization created with only `agents.run` directly
  granted keeps working unchanged (system-role re-seeding doesn't touch custom roles).
- **Files:** `database/prisma/seed.ts`, `apps/api/src/agents/agent.controller.ts`.
- **Verified:** `tsc --noEmit` clean. Ran `npm run db:seed` against the live dev database (additive/
  idempotent — no data loss, confirmed by inspecting `role_permissions` before/after) to retroactively
  grant the new permission to the existing UAT organization's roles. Live-tested end to end: the
  previously-created real Viewer-role user (invited and accepted earlier in this UAT) now gets
  `200 OK` with the full employee list from `GET /agents`, while `POST /agents/run` for the same user
  still correctly returns `403 AUTHORIZATION_FAILED` — read access granted, execute access still denied,
  exactly as intended.

### UAT-007b — the backend fix alone wasn't enough: the dashboard's own permission-discovery mechanism was broken for every non-Owner role (found and fixed in the same follow-up)

Verifying UAT-007's fix through the actual browser (not just curl) surfaced a second, much larger,
pre-existing bug behind the same symptom — logging in as the real Viewer user still showed "Access
denied" on the AI Employees page even after the backend fix above.

- **Root cause:** the dashboard's `PermissionProvider` (the one mechanism every `AccessGate`/`Can` check
  in the whole app depends on) computed "what can I do" by calling `GET /users/:id` and `GET /roles` —
  both of which require the admin-only `users.read`/`roles.read` permissions. Checked the full
  `DEFAULT_PERMISSIONS` seed data: **only the Owner role has either of those permissions** — Admin,
  Manager, Member, and Viewer all lack both. That means every one of those roles' `GET /users/:id`/
  `GET /roles` calls 403'd, `PermissionProvider` silently computed an *empty* permission set, and the
  entire dashboard UI showed "Access denied" on every gated page for every non-Owner user, regardless of
  what permissions they actually held. UAT-007's original, curl-only testing never caught this because it
  never drove the real browser as anyone but the Owner-role UAT admin and a Viewer checked only via
  direct API calls, not the rendered page.
- **Fix:** added a new, self-scoped `GET /auth/me/permissions` endpoint (`auth.controller.ts`) — guarded
  only by `JwtAccessGuard`, no `RequirePermission`, exactly like the pre-existing `/auth/me` — that
  returns the caller's own effective permissions via `AuthorizationService.getEffectivePermissions()`
  (the same authoritative source `PermissionGuard` itself already uses server-side, so this can never
  drift from what the backend actually enforces). Added `ApiClient.myPermissions()`
  (`apps/dashboard/src/lib/api-client.ts`) and switched `PermissionProvider` to use it instead of the two
  admin-gated queries for every non-platform-owner user (the separate platform-owner catalogue path was
  already correct and untouched).
- **Files:** `apps/api/src/identity/presentation/http/auth.controller.ts`,
  `apps/dashboard/src/lib/api-client.ts`, `apps/dashboard/src/features/admin/authorization.tsx`. Also
  wrapped the AI Employees list page's previously permission-less "Run" button in
  `<Can permission="agents.run">` (`agent-pages.tsx`) — matching the existing pattern already used for
  its neighboring "Install" button — so a Viewer (who can now see the list) doesn't hit a dead-end
  "Access denied" click-through; extended `AccessGate` itself to optionally accept an array of
  permissions (`"any of"` semantics, backward compatible with all 45 existing single-string call sites).
- **Verified:** `tsc --noEmit` clean on both apps. Dashboard suite: 186/188 pass (the 2 failures are
  confirmed pre-existing and completely untouched by this diff — a placeholder-text test and a
  `channel-api.spec.ts` test, neither related to permissions). `authorization.spec.ts`'s 7 pure-function
  tests pass unchanged (the exported helpers kept their exact signatures). Live-verified in the real
  browser: `GET /auth/me/permissions` for the Viewer user returns its full 17-permission set including
  the new `agents.read`; the AI Employees page now renders correctly for that Viewer (all 3 installed
  employees visible, zero "Run"/"Install" buttons shown, matching its role); logged in separately as the
  real Owner-role UAT user and confirmed zero regression — Run/Install buttons still present, and an
  actual "Run" click still opens the working chat interface.

## UAT-008 — Meta WhatsApp channels could never be created through the API (FIXED)

- **Severity:** Major (blocked the entire WhatsApp channel setup path via the public API/dashboard).
- **Area:** Channel management (`channel.dto.ts`).
- **Found during:** Phase 19 (WhatsApp simulation) setup — creating a `META_CLOUD_API` channel via
  `POST /channels` with real Meta configuration fields (`metaAppId`, `metaAppSecret`,
  `whatsappBusinessAccountId`, `phoneNumberId`, `displayPhoneNumber`, `accessToken`,
  `webhookVerifyToken`) failed with `400 VALIDATION_ERROR`: `"configuration.property metaAppId should
  not exist"` (and the same for every other Meta field).
- **Root cause:** `CreateChannelDto.configuration` is typed as a union
  (`TwilioConfigurationDto | MetaWhatsAppConfigurationDto`), but was decorated with a hardcoded
  `@Type(() => TwilioConfigurationDto)` — class-transformer always instantiated/validated the nested
  object as Twilio's shape regardless of the sibling `provider` field, so every Meta-specific property
  was rejected as unknown ("should not exist"), no matter what `provider` said. There is no test
  coverage that exercises real channel creation through the HTTP/DTO layer (the existing
  `channel-delivery.spec.ts` fixtures create `ChannelConnection` rows directly via Prisma, bypassing
  the controller entirely), which is why this had never been caught.
- **Fix:** Replaced the hardcoded `@Type()` with a `@Transform()` that reads the sibling `provider`
  field from the object being validated and instantiates the correct class (`MetaWhatsAppConfigurationDto`
  for `META_CLOUD_API`, `TwilioConfigurationDto` otherwise) via `plainToInstance`. `UpdateChannelDto`
  has no `provider` field at all (it's immutable post-creation — `ChannelService.update()` already
  looks up the existing row's real provider from the DB and branches correctly), so there's no sibling
  signal to discriminate on for updates; introduced a single `ChannelConfigurationUpdateDto` with every
  field from both provider shapes marked optional, so an update payload for either provider validates
  correctly and the service's own provider-aware branching (already correct) takes it from there.
- **Files:** `apps/api/src/channels/channel.dto.ts`.
- **Verified:** `apps/api/src/channels` suite: 68/73 tests pass (the other 5 are the
  pre-existing, unrelated `META_WEBHOOK_SIGNATURE_VERIFICATION_FAILED` failures already documented
  above). `tsc --noEmit` clean. Live-tested: `POST /channels` with a full Meta configuration payload now
  returns `201 Created` with a real `ChannelConnection` row (`provider: META_CLOUD_API`,
  `whatsappBusinessAccountId`, `phoneNumberId`, `displayPhoneNumber` all persisted correctly, secrets
  encrypted — `secretMetadata.appSecret.configured: true` — never returned in plaintext).

## Confirmed-working (Phase 19, WhatsApp text simulation) / (Phase 25, idempotency)

- After fixing UAT-008, created a real `META_CLOUD_API` WhatsApp channel connection (fake but
  well-formed credentials — never real Meta secrets, per the UAT's constraints), enabled it
  (`DRAFT → ACTIVE`), then simulated a genuine inbound WhatsApp webhook: built the exact Meta webhook
  JSON payload (`entry[0].changes[0].value.messages[0]`, `messaging_product: "whatsapp"`) and computed
  a real `HMAC-SHA256` signature over the raw body with the channel's configured app secret, sent as
  `x-hub-signature-256: sha256=...` — i.e. exercised Meta's actual webhook security mechanism for real,
  not a stubbed bypass.
- **Full real pipeline confirmed via direct DB inspection:**
  - `channel_messages`: one `INBOUND` row (`status: SENT`, correct `provider_message_sid`,
    `from_address`/`to_address`), one `OUTBOUND` reply row.
  - `interactions`: a real `KRV-7JMXP8` reference created with `channel: WHATSAPP`,
    `external_user_id: +919876500001` — confirms the "shared channel identity" resolution path in
    `InteractionService.findOrCreate` (the one UAT-003 found doesn't cover web chat) works correctly
    for its intended case, a genuine channel-identity actor.
  - The deterministic AI Receptionist correctly processed the inbound text and generated a real,
    on-topic reply ("Sure, I can help with that. Before I connect you, may I know your name?") — same
    conversational engine as the web chat golden path, now proven to also run over the WhatsApp
    ingestion path, not a separate/parallel implementation.
  - Outbound delivery correctly **failed** with a clean, classified `error_code: AUTH_FAILURE` (since
    the test credentials are intentionally fake) rather than crashing or hanging — proves the
    provider-error-classification system is real and reachable, not just unit-tested in isolation.
- **Idempotency verified**: replayed the exact same webhook payload (same `provider_message_sid`,
  correct signature) a second time. Response was still `200 {}` (Meta's expected fast-ack), and direct
  DB counts confirmed **no duplicate** was created: still exactly 1 `channel_messages` row for that
  message id, still exactly 1 `Interaction` for that phone number. Confirms the `P2002`
  unique-constraint dedup on `(channelConnectionId, providerMessageSid)` genuinely prevents double
  processing of a retried/replayed webhook delivery.

## Confirmed-working (Phase 12-14, interaction completion / reference notification — closing-remark path)

- Distinct from UAT-004 (Travel lead-submission never completing the Interaction): sent a plain web-chat
  closing remark ("That is all, thanks, bye!") to AI Receptionist via a live `POST /agents/run` call.
  Confirmed via direct DB inspection: `Interaction.status` correctly transitioned `ACTIVE → COMPLETED`,
  `completedAt`/`referenceCommunicatedAt` both stamped, the chat response text itself correctly appended
  the customer-facing closing line ("You're all set — I've saved this under reference KRV-BTKD4S. If you
  contact us again, just share that reference."), a `NOTIFICATION_JOBS` queue message was enqueued and
  the real background worker processed it to `COMPLETED` within seconds (no manual intervention) — the
  full completion→notification pipeline is real and working for the one trigger that is wired
  (an explicit closing phrase), end to end, exactly as designed.

## UAT-009 — Generic "human takeover" escalation gate silently drops Travel Employee's configured escalation contact (FIXED, 2026-09-21)

- **Severity:** Minor/UX regression (the customer still gets escalated to a human — nothing breaks — but
  loses a real piece of information: the configured contact email).
- **Area:** `agent.service.ts`'s "Sprint 6.7 — human takeover gate" vs. Travel Employee's own,
  older, domain-specific escalation response.
- **Found during:** the final full-suite regression pass — `travel.e2e.spec.ts`'s "escalates to a human
  and surfaces the configured escalation contact" test failed: expected the response to contain the
  configured `humans@voyager.example`, got the generic "Sure — I'll hand this over to a team member."
  instead (no contact info at all).
- **Root cause (pre-existing, predates this UAT and Sprint 7.12 — confirmed NOT caused by any change in
  this session):** `agent.service.ts` has a generic, employee-agnostic "human takeover" gate (comment:
  "Sprint 6.7") that runs for every AI Employee, immediately after the user's message is stored and
  before any domain-specific logic: if the message matches a generic escalation phrase pattern
  (`HUMAN_ESCALATION_REQUEST_PATTERN_EN`/`_HI`), it unconditionally flips the conversation to
  `HUMAN_ACTIVE` and replies with a fixed, generic acknowledgement
  (`HUMAN_HANDOFF_ACKNOWLEDGEMENT_EN = "Sure — I'll hand this over to a team member."`) — this runs
  *before* Travel Employee's own, older escalation-response logic
  (`travel.runtime.ts`'s `escalationContact`-interpolating message,
  `"I'll connect you with a human team member. You can reach us directly at ${config.escalationContact}..."`)
  ever gets a chance to run, so Travel's richer, contact-info-bearing response can now structurally never
  fire for any message the generic pattern also matches.
- **Fix:** Carved Travel Employee out of the generic escalation-phrase match (the `escalationMatch`
  computation now short-circuits to `null` whenever `isTravelEmployee`, leaving the rest of the gate —
  including the `HUMAN_ACTIVE`-pause check for a conversation a human has already actually taken over —
  untouched for every employee, Travel included). Dispatch then proceeds normally to Travel's own
  runtime, which already has a complete, self-contained escalation implementation (`ESCALATION_MARKER`
  detection, its own `ESCALATED` stage, and the `escalationContact`-interpolated reply) — confirmed
  working correctly once it's actually allowed to run; nothing needed to be built, only un-shadowed.
  Deliberately scoped to Travel only (not every `employeeConfig`-bearing domain) since Travel is the one
  case with a verified, complete alternative flow already in place; broadening this to other domain
  employees without the same verification would risk silently disabling their generic human-takeover
  pause for no proven benefit.
- **Files:** `apps/api/src/agents/agent.service.ts` (~line 1040-1089).
- **Verified:** `apps/api/src/travel/travel.e2e.spec.ts` now passes 17/17 (was 16/17). The dedicated
  `agent.service.human-takeover.spec.ts` suite (6 tests, exercises a non-Travel employee) passes
  unchanged. Live-tested end to end against the real running dev server: asking Travel Employee "I would
  like to talk to a human agent please" now returns "I'll connect you with a human team member. You can
  reach us directly at support@ai-workforce-os.example." (the org's real, configured — here, still
  default — escalation contact) and the Travel conversation's own `state.stage` reads `"ESCALATED"`,
  while `conversations.ai_control_state` correctly stays `AI_ACTIVE` (Travel owns this, not a human-queue
  pause). Cross-checked that a **non-Travel** domain employee (Customer Support) asked the identical
  phrase is completely unaffected: still gets the generic "Sure — I'll hand this over to a team member."
  reply and `ai_control_state` correctly flips to `HUMAN_ACTIVE` / `aiPausedReason: ESCALATION_REQUEST`.

## Non-defect: `interaction-voice.e2e.spec.ts` fails deterministically — pre-existing test-harness gap, not a regression or live defect

- **Found during:** re-running the `src/interaction` suite after the UAT-005/006/008 fixes, to confirm
  no regressions. One test — `interaction-voice.e2e.spec.ts` ("creates an Interaction at call start...
  and completes+speaks it on a closing remark") — failed 100% reproducibly (3 isolated re-runs, no
  parallelism) at its final assertion: `expect(notificationCount).toBeGreaterThan(0)` got `0`.
- **Investigated thoroughly before concluding non-regression**, since this exact file passed in an
  earlier run this session (`105/105` in a combined `src/interaction` + `agent.service.spec.ts` run):
  read the full test file, confirmed every assertion *before* the failing one — Interaction created at
  call start, correctly linked to the Receptionist's conversation on the first turn (no duplicate),
  completed on the closing remark, `referenceCommunicatedAt` set, and the reference actually **spoken**
  into the agent's transcript in voice-friendly spaced form — all pass. Only the final notification-count
  check fails.
- **Root cause, confirmed via the test's own separate Postgres test DB
  (`ai_workforce_os_test`)**: `queue_messages` shows the `NOTIFICATION_JOBS` job **was** correctly
  enqueued (`status: QUEUED`) — `InteractionCompletionService.complete()` itself works. But it sits
  `QUEUED` forever because `QueueConsumerWorker.onModuleInit()` (`apps/api/src/queue/queue-worker.ts:50`)
  explicitly does `if (process.env.NODE_ENV === "test") return;` before starting its polling
  `setInterval` — a deliberate guard (so tests don't race a live background timer) — and this test
  never manually calls `processOnce()`/any equivalent trigger to process the queue itself, so the job
  is never picked up within the test's ~1-second lifetime. This is a gap in the test's own design
  (missing a manual drain step), not in the underlying notification system, and — per `git status` at
  the start of this UAT session — the entire `queue/` subsystem is part of the separate, concurrently
  developed "production readiness" work, not Sprint 7.12/this UAT's own changes.
- **Confirmed the real, live system is unaffected** — reproduced the identical scenario against the
  actual running dev API (`NODE_ENV=development`, where the guard above does *not* apply): sent "Hello"
  then a closing remark ("That is all, thanks, bye!") to AI Receptionist via `POST /agents/run`.
  Result: `Interaction` correctly `COMPLETED` with `reference_communicated_at` set, the chat response
  correctly appended "You're all set — I've saved this under reference KRV-BTKD4S...", and — critically —
  the real background `QueueConsumerWorker` picked up the job and completed it
  (`queue_messages.status: COMPLETED`, `attempt_count: 1`) within seconds, with zero manual intervention.
  Zero `interaction_notifications` rows were created for this specific case, which is *correct*: this
  web-chat customer never provided a phone/email, so the notification orchestrator correctly has no
  channel to notify through and no-ops rather than fabricating a failed/empty notification record.
- **Conclusion:** not a regression from any UAT-00X fix (all of which were independently verified clean
  against this same suite before this test's own investigation began), not a live product defect — a
  pre-existing e2e test-harness gap in unrelated infrastructure. Flagged here rather than fixed, since
  patching another team's queue-worker test harness is outside this UAT's fix scope (test infrastructure
  for a subsystem this UAT isn't auditing).

## Confirmed-working (Phase 22, RBAC)

- Platform-owner-only endpoints correctly reject a regular (non-platform-owner) organization owner:
  `GET /platform/organizations` with a valid but non-platform-owner token → `403 AUTHORIZATION_FAILED`.
- Role/permission system is real, not hardcoded: `GET /roles` for the UAT org returns 5 real
  system roles (Owner 129 permissions, Admin 100, Manager 60, Member 11, Viewer 14) each with a distinct,
  granular permission set loaded from the database.
- Full real invitation → accept → login → permission-enforced-request round trip verified for the
  "Viewer" role: `POST /invitations` (real token issued) → `POST /invitations/accept` (real account
  created, correctly assigned the Viewer role) → login → `POST /agents/run` correctly denied with
  `403 AUTHORIZATION_FAILED`. (Originally also found Viewer couldn't list employees at all via
  `GET /agents` — see UAT-007 above, now fixed and reverified with this same Viewer account.)

## Confirmed-working (Phase 39, security smoke test) / (Phase 34, migration status)

- `npx prisma migrate status`: 60 migrations found, database schema up to date — no drift, no pending
  migrations, confirming the live dev DB matches the tracked migration history exactly.
- No secrets (`password`/`apiKey`/`secret`/`token`) leaked in the `GET /agents` (AI Employees list)
  response — scanned the full response body directly.
- Correct security headers present on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
  base-uri 'none'`. No `X-Powered-By` framework-fingerprinting header.
- CORS correctly does not reflect a disallowed origin (`https://evil-attacker.example.com` sent no
  `Access-Control-Allow-Origin` back — the browser would block the response).
- Login brute-force protection (`AUTH_STRICT` rate limit, 10 requests / 5 minutes) is real and
  enforced: 10 rapid wrong-password login attempts all correctly returned `401`, the 11th–14th
  correctly returned `429 Too Many Requests`.

## Non-defect: cross-file e2e test-teardown ordering issue (`channel_connections` FK) — pre-existing, unrelated to Sprint 7.12

- **Found during:** the full e2e regression pass. Three unrelated e2e spec files
  (`employees.e2e.spec.ts`, `knowledge.e2e.spec.ts`, `memory.e2e.spec.ts` — none touched by this UAT or
  the concurrent production-readiness work) intermittently fail their own `afterEach`/`afterAll` cleanup
  with the identical error: `Foreign key constraint violated on the constraint:
  channel_connections_plugin_installation_id_fkey` when calling `prisma.plugin.deleteMany()`, because
  some other e2e spec file running earlier in the same full-suite pass leaves a `channel_connections`
  row pointing at a plugin these files then try to delete, and none of the three delete
  `channel_connections` as part of their own cleanup sequence.
- **Confirmed pre-existing and unrelated to any change made in this UAT**: none of the three affected
  files, nor `channel_connections` cleanup ordering, appear anywhere in this session's diff. The
  isolated test database (`ai_workforce_os_test`) was confirmed empty/consistent after the full run
  (no permanent corruption — purely a transient cross-file ordering race when many e2e specs share one
  test database in a single run). Run-to-run variance was observed directly: a first full-suite run
  showed 21 failed files/42 failed tests, a second immediate re-run of the identical command showed 8
  failed files/10 failed tests — the signature and magnitude of classic shared-test-database race
  conditions, not deterministic logic regressions.
- **Not fixed**: this is existing test-infrastructure fragility spanning several files outside Sprint
  7.12's scope; flagged for the owning team rather than patched mid-UAT.

## Non-defect: 7 pre-existing unit test failures unrelated to Sprint 7.12 (full regression pass)

Full non-e2e unit suite run (`vitest run --exclude "**/*.e2e.spec.ts"`, no file parallelism):
**2,559 passed, 1 skipped, 7 failed** across 177 files. All 7 failures are confirmed unrelated to
Sprint 7.12/this UAT's own changes — neither caused by UAT-003's fix nor by the UAT-005 module-wiring
fix (both of which were verified clean in isolation, see above):

- **5 failures in `apps/api/src/channels/channel-delivery.spec.ts`** — `META_WEBHOOK_SIGNATURE_VERIFICATION_FAILED`.
  Root cause confirmed via `git diff`: `meta-webhook.controller.ts` (part of the separate, concurrent
  "production readiness" work found sitting in the tree this session — see UAT-005) was deliberately
  tightened from logging-and-accepting an unsigned webhook (`appSecret` missing → warn + continue) to
  hard-rejecting it (`throw new Error("META_WEBHOOK_SIGNATURE_VERIFICATION_FAILED")`) — a real,
  intentional security hardening (closing exactly the gap a prior sprint's report flagged as "a real,
  narrow gap" and deliberately left open). The test fixtures in `channel-delivery.spec.ts` still set up
  channels without an `appSecret` and expect the old lenient behavior, so they now fail. This is stale
  test coverage for someone else's in-progress security fix, not a Sprint 7.12 regression — left
  untouched since editing another workstream's tests mid-flight (while it was still being actively
  edited, per UAT-005) would risk conflicting with that work.
- **2 failures in `apps/api/src/travel/travel.llm.spec.ts`** — hardcoded-date assumptions
  (`expect(...).toBe("2026-08-15")`) that fail once the real calendar date passes the test's assumed
  "today" (a lone "15 August" now correctly resolves to the *next* August 15, i.e. 2027, since 2026's
  has already passed) — the same category of pre-existing, date-dependent flakiness documented as a
  known baseline issue in prior sprint reports, not a functional defect.

## Non-defect: tool-use error during Travel Employee install (no product bug)

- While installing AI Employees, an early `Install` click for "Travel Employee" used a
  DOM-text-based lookup that matched the wrong node first (a sidebar nav link also containing
  the text "Travel Employee") and clicked something inert — no install request fired for that
  attempt. Re-verified: the correct card element's `Install` button worked immediately once
  targeted directly (`.employee-card` containing the `<h3>Travel Employee</h3>`), producing a real
  `201 Created` and a genuine DB row (`plugins.slug = 'travel-employee'`, `status = ACTIVE`).
  Logged here only so the earlier misleading network-trace read (which looked like a duplicate
  201) doesn't get misattributed as a backend idempotency bug in the final report — it was purely
  a browser-automation targeting mistake on my part, not an application defect.

## Non-defect: chat message appeared not to render (test-timing artifact, not a bug)

- While testing the web chat golden path, an automated "type + click Send" sequence appeared to
  silently fail: `POST /agents/run` returned `201`, but the UI kept showing the empty welcome
  screen with no message bubbles. Root cause: the Receptionist proactively greets on mount
  (`startNewConversation` fires `run.mutate({message:""})` immediately), and the Send button is
  `disabled={run.isPending}` for the whole time that greeting call is in flight. My click landed
  while it was still pending, so the disabled button silently no-op'd — nothing was wrong with the
  send path itself. Confirmed by re-running the exact same steps after waiting for the greeting
  mutation to resolve (`Send` button `disabled` became `false`): the user message and assistant
  reply rendered immediately and correctly. Logged here only so this isn't misattributed as a
  chat-rendering defect in the final report.

## Confirmed-working (Phase 8, web chat golden path)

- Sending "Hi" to AI Receptionist creates real, correctly-linked rows: `Interaction`
  (`reference_id = KRV-JMWBS3`, `channel = WEB_CHAT`, `status = ACTIVE`, correct
  `organization_id`, `entry_agent_id`/`current_agent_id` = AI Receptionist plugin id) and
  `conversation_messages` (proactive `ASSISTANT` greeting → `USER` "Hi" → `ASSISTANT` reply, in
  correct order with real timestamps). Verified directly via `psql`, not inferred from the UI.

## Confirmed-working (Phase 9, knowledge base / RAG)

- Uploaded documents index correctly (`knowledge_documents.status = INDEXED`) and are scoped per AI
  Employee (`plugin_installation_id`) — a Receptionist-scoped collection is structurally invisible to
  Travel or Customer Support's own searches, confirmed by reading `KnowledgeSearchService.runSearch`'s
  `WHERE c.plugin_installation_id = ${employeeId}` filter directly.
- Real retrieval pipeline confirmed end-to-end against Customer Support Employee (a "shared-engine"
  domain employee — the Receptionist is a pure deterministic router with no knowledge path by design,
  and Travel Employee's knowledge answers route through its own LLM orchestrator instead): request
  classification (`KNOWLEDGE_QUERY`), pgvector nearest-neighbor search, hybrid semantic+keyword+
  heading-boost scoring, a deliberate two-tier confidence gate (a lower recall threshold for candidate
  retrieval vs. a stricter `MIN_ANSWER_SCORE` before a chunk is ever presented as a direct answer), and
  correct citation. All verified directly via `execution_spans.attributes_json` (`KNOWLEDGE_SEARCH`
  span: `grounded`, `topSimilarityScore`, `chunksSearched`/`chunksReturned`, `fallbackReason`), not
  inferred from chat text alone.
- **Correctly refuses to hallucinate**: a query whose top match scored 0.3234 (just under the ~0.33
  answer-confidence bar) was honestly answered "I could not find this information in the uploaded
  knowledge." rather than presenting a low-confidence guess — confirmed this is a deliberate, documented
  design (`knowledge.prompt.ts`'s `buildKnowledgeAnswer`/`isConfidentAnswer`), not a retrieval failure:
  the same document, asked about with slightly higher phrase overlap, scored 0.3637 and was answered
  correctly with a citation.
- **Environment note, not a defect**: this organization has zero AI provider connections configured
  (`ai_provider_connections` table empty for this org — verified via `psql`), so every AI Employee here
  runs on the platform's built-in `DETERMINISTIC` embedding/completion providers rather than a real LLM.
  The deterministic embedding provider (`DeterministicEmbeddingProvider`, a SHA-256 hashed
  bag-of-tokens vector) is a legitimate, intentional dev/test mode — real semantic embeddings would
  score confidently on a much wider range of question phrasings than the crude hash-based one did, so
  a few of my early test questions needed rephrasing (closer literal keyword/phrase overlap with the
  source document) before clearing the confidence bar. This is expected behavior of the deterministic
  fallback, not a bug, and matches the UAT's own instruction not to invent real OpenAI credentials —
  classified as **EXTERNAL ACTIVATION PENDING** for true semantic-embedding-quality RAG, while the
  retrieval/grounding/confidence-gating architecture itself is verified fully real and correct.

## Confirmed-working (Phase 10, workflow execution) / Finding (Phase 11, human approval — not a defect, a reachability gap)

- **Workflow execution confirmed real**: every "travel request submitted" chat outcome corresponds to a
  real `WorkflowExecution` row (`workflow_type = TRIP_SUBMISSION`, `status = COMPLETED`), verified via
  `psql`, not inferred from chat text.
- **Human approval architecture is real but not reachable from the customer-facing web chat golden
  path in this build.** Investigated deliberately since the org had zero `approval_policies` rows and
  zero `approval_requests` ever created. Traced the code: a full approval system exists
  (`ApprovalPolicyEngine`, `ApprovalService`, `WorkflowCoordinator.requestApproval`,
  `TravelBookingService.confirmApprovalAndBook`) and — per the earlier full regression run — is covered
  by passing automated tests. However, `TravelBookingService`'s approval-gated real-booking path
  (`BOOKING_HANDOFF` workflow) is only reached via a `START_BOOKING_HANDOFF` signal in
  `travel.runtime.ts`; the standard customer chat "plan → confirm → phone number" flow I walked through
  (both with a below-minimum budget and, on retest, a generously above-minimum $5,000 budget, plus an
  explicit "book it now" phrasing) always produced a `TRIP_SUBMISSION` (lead-capture) workflow instead —
  zero `TravelBooking` rows were ever created by any customer-facing interaction in this UAT.
  **Test method:** temporarily inserted one `approval_policies` row (`TRAVEL`/`BOOKING`,
  `ORGANISATION_ADMIN`, `SINGLE`) to verify a policy's mere presence wasn't itself the blocker — it made
  no difference, confirming the gap is that the `BOOKING_HANDOFF` signal path is simply never dispatched
  by this chat journey, not a missing-policy configuration issue. The test policy row was deleted again
  immediately after (`DELETE ... RETURNING id` confirmed 1 row removed) — no residual test data left in
  the org.
- **Conclusion for the report:** classify as a golden-path gap, not "PASS" — the approval subsystem
  itself is real, tested, and architecturally sound, but the currently-shipped Travel Employee customer
  chat journey never exercises it end-to-end (it only ever produces a human-follow-up lead, consistent
  with the employee's own stated design: "Never claims a booking occurred"). Recommend as follow-up work
  to identify/wire whatever customer signal is meant to trigger `START_BOOKING_HANDOFF`, or to explicitly
  document that a human travel agent's own (currently UI-less) conversion of a lead into a `TravelBooking`
  is the only intended entry point.

## Confirmed-working (Phase 5-7, no defect)

- Signup → login → dashboard shell render.
- Invalid password on login → real `401` from `/auth/login`, UI renders
  "Authentication failed — Invalid email or password." inline, no crash/blank page.
- Logout (via user-menu dropdown → Logout) clears session; subsequent protected-route visit
  redirects to `/login?returnUrl=...`.
- AI Employees page: install flow for AI Receptionist and Travel Employee, both confirmed via
  direct Postgres query (`plugins` table, `status = ACTIVE`, correct `organization_id`).
  Available-plugins list correctly shrinks from 10 to 8 after 2 installs — no cross-tenant plugins
  visible.
- Travel Employee `/travel-employee` config page loads with correct ACTIVE status, persona/config
  form, and email delivery (SMTP) section. No console errors.
