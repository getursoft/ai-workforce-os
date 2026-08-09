# Customer Onboarding

Sprint 5.0 Phase 12/28. What exists today vs. what a full guided-onboarding flow would add.

## What already works end-to-end

1. **Create organization + owner** — `POST /auth/register` (self-service, gated by
   `PUBLIC_SIGNUP_ENABLED`) or `POST /platform/organizations` with `ownerEmail`/`ownerPassword` (platform-
   owner-provisioned, the only path when self-service is disabled — e.g. this repo's own
   `.env.production.example` sets `PUBLIC_SIGNUP_ENABLED=false`). Both create the organization and its
   first Owner user in one transaction.
2. **Select a plan / apply entitlements** — no dedicated "choose a plan" UI exists yet; an
   `OrganisationSubscription` row (linking to a `SubscriptionPlan`) is created out-of-band today (support/
   sales-assisted, or a direct DB operation). Once it exists, `EntitlementService` and
   `BillingEnforcementService` immediately start applying its limits — no separate "activation" step.
   An org with **no** subscription row is treated as unmetered (existing behavior, preserved deliberately
   so dev/legacy orgs aren't retroactively broken — see `BillingEnforcementService`'s doc comment).
3. **Install employees** — `POST /plugins/install`, gated by `EntitlementService`'s `MAX_EMPLOYEES` check
   as of Sprint 5.0. Each org chooses its own workforce; nothing requires installing all employee types.
4. **Configure an AI provider** — per-employee provider configuration exists (`PluginAiService`); a
   platform-managed default provider path also exists for orgs that don't configure their own.
5. **Upload knowledge** — `POST /knowledge/employees/:employeeId/collections/:collectionId/documents`,
   rate-limited (`FILE_UPLOAD` category) and gated by `MAX_UPLOAD_BYTES`.
6. **Configure a channel** — WhatsApp (Meta Cloud API) / Twilio connection setup, gated by
   `MAX_WHATSAPP_CHANNELS`.
7. **Invite team members** — `POST /users` (existing, not part of this pass).
8. **Test an employee** — the dashboard chat UI against any installed employee, immediately.

## What does NOT exist yet (honest gap)

- **No onboarding-checklist UI or API** — no endpoint returns "here's what this org has/hasn't completed
  yet" as a structured progress object. The individual steps above all work; there is no orchestrating view
  tying them together into a guided flow with a completion percentage.
- **No email verification** — signup is instant, no verification token/flow exists (flagged in the Phase 1
  audit and Phase 8 security review; a real gap, not addressed in this pass).
- **No in-dashboard plan-selection/trial flow** — subscription creation is not self-service.

## If building the onboarding-checklist UI next

The natural shape, given what exists: a computed (not stored) checklist derived from real state —
`hasEmployee = EntitlementService.getUsage(org, "MAX_EMPLOYEES") > 0`, `hasProvider = ...`,
`hasKnowledge = ...`, `hasChannel = EntitlementService.getUsage(org, "MAX_WHATSAPP_CHANNELS") > 0`,
`hasInvitedTeam = user count > 1`, `hasTestedEmployee = agentExecution count > 0`,
`hasBillingConfigured = subscription exists`. Each check is already backed by a real query via services
built in this pass — no new schema needed for a v1 checklist endpoint, just an aggregating read.
