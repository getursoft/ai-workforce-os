# Krevia CRM

Krevia's built-in, tenant-scoped CRM. Customer organizations manage the leads their AI workforce generates
(web chat, WhatsApp, voice) without needing HubSpot, Salesforce, or Zoho. An external CRM connector is
always optional — the internal `Lead` record is persisted first and never depends on one.

## Data model

- `Lead` (`leads` table) — canonical, tenant-scoped lead: `leadReferenceId` (`KRV-LD-XXXXXX`), `name`,
  `phone`, `email`, `source` (`WEB_CHAT | WHATSAPP | VOICE | MANUAL | API | OTHER`), `agentId` (specialist AI
  Employee's plugin installation id), `conversationId`, `interactionId`, `voiceSessionId`, `requirement`
  (short summary, never a full transcript), `status` (`NEW | CONTACTED | QUALIFIED | FOLLOW_UP | CONVERTED |
  LOST`), `priority`, `assignedToUserId`, timestamps.
- `LeadActivity` (`lead_activities` table) — append-only timeline: `CREATED | UPDATED | STATUS_CHANGED |
  ASSIGNED | NOTE_ADDED | CONTACTED | CONVERTED | LOST`.

Both are additive Prisma models (migration `20260921120000_krevia_crm_leads`) alongside the existing
per-vertical detail records (`TravelLead`, `SalesLead`, ...), which keep owning their own rich domain fields.
`Lead` is the thin, cross-vertical rollup those services mirror into — never a duplicate/competing model.

## Capture path

`LeadService.captureFromChannel` (`apps/api/src/leads/lead.service.ts`) is the single, channel-agnostic entry
point. `TravelLeadService.createInternalLead` calls it after persisting the domain `TravelLead` — so every
existing Travel Employee capture trigger (LLM tool call, deterministic engine, Contact Capture workflow, Trip
Submission workflow, below-minimum-budget handoff) automatically produces a Krevia CRM `Lead` too, with zero
duplicated capture logic.

Dedup/update: the same Interaction (survives a Receptionist → specialist handoff) or conversationId resolves
to the same still-open `Lead` and updates it in place — a continued conversation never creates a duplicate.
Channel attribution comes from the resolved `Interaction.channel`, so WEB_CHAT/WHATSAPP/VOICE are automatic
regardless of which specialist AI Employee handled the conversation.

A future AI Employee (Sales, ...) wires in the same way: call `LeadService.captureFromChannel` from its own
domain-lead persistence path, same as `TravelLeadService` does.

## API (`/api/v1/leads`)

`GET /`, `GET /summary`, `GET /:id`, `GET /reference/:referenceId`, `GET /:id/activity`, `POST /` (manual
create), `PATCH /:id`, `POST /:id/notes`, `POST /:id/assign`. Tenant-scoped, JWT + permission-guarded
(`leads.read/create/update/assign/notes`), pagination + filter by status/source/agent/assignee/search/date.
Plain bearer-token JSON — usable by a future Android/iOS client unchanged.

## Dashboard

Sidebar entry "Krevia CRM" → `/crm` (summary tiles, filterable/paginated lead table, manual-create dialog) and
`/crm/leads/[id]` (detail: status change, assign, add note, activity timeline).

## Tests

- `apps/api/src/leads/lead.service.spec.ts` — capture/dedupe/tenant-isolation/manual-lifecycle unit tests.
- `apps/api/src/leads/lead.controller.permissions.spec.ts` — RBAC wiring.
- `apps/api/src/leads/lead.e2e.spec.ts` — real Postgres UAT: Web→Receptionist→Travel handoff capture + update,
  WhatsApp channel actor, Voice simulator, manual lifecycle, tenant isolation, CRM-disabled behavior.
