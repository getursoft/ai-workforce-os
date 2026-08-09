# Operations

Sprint 5.0 Phase 28. Day-to-day operational reference — for incidents, see `docs/operations/`.

## Health surfaces

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health/live` | none, rate-limit-exempt | Container liveness — process is up |
| `GET /health/ready` | none, rate-limit-exempt | Load-balancer/orchestrator readiness — DB + queue table reachable |
| `GET /observability/health` | `observability.read` permission, org-scoped | 12-component operator view (API, Database, Provider, Workflow Engine, Background Worker, Memory, Knowledge, WhatsApp, Email, Scheduler, Connector Runtime, Background Queue) |
| `GET /platform/organizations/:id/summary` | platform owner only | Tenant-safe operational summary (counts only — active employees, users, channels, failed executions, open alerts, subscription status) |

## Common operational tasks

**Check what a background worker is doing:** each poller (`SchedulerService`, `WorkforceTaskProcessor`,
`ChannelMessageProcessor`, `ObservabilityRetentionService`, `QueueConsumerWorker`) exposes a
`getLastPollAt()`/`getLastRunAt()` — a stale timestamp (older than ~3x its poll interval) means the loop
stopped ticking, not just that there was no work. `ObservabilityHealthService` already surfaces this.

**Inspect the queue:** `QueueHealthService.snapshot()` (backing the "Background Queue" health component) —
queued/claimed/completed/failed/retrying/dead-lettered counts, stale-claim count, oldest-queued-message
age. `BackgroundQueue.list(organizationId, filters)` for a per-tenant view.

**Suspend a misbehaving/non-paying tenant:** `POST /platform/organizations/:id/suspend` (platform owner
only) — immediately blocks login for every user in that org (enforced in `LoginHandler`, not just cosmetic
in the dashboard). `POST .../reactivate` to restore.

**Add a support note:** `POST /platform/organizations/:id/support-notes` — visible to any platform owner
investigating that tenant later; not visible to the tenant itself.

**Toggle a feature flag:**
`FeatureFlagService.setPlatformFlag(key, enabled)` / `.setOrganizationFlag(orgId, key, enabled)` — no HTTP
endpoint exists for this yet (service-only as of Sprint 5.0); call it from a one-off script or add a route
when a real rollout need arises.

**Rotate a secret:** see `docs/operations/runbooks/credential-rotation.md`.

**Back up / restore the database:** see `docs/operations/backup-and-restore.md`.

## Logs

Structured JSON via Nest's `Logger`, one line per event with an `event` field (e.g. `SLOW_QUERY`,
`DATABASE_CONNECT_RETRY`, `QUEUE_STALE_CLAIMS_RECOVERED`, `BILLING_EXECUTION_BLOCKED`,
`ENTITLEMENT_LIMIT_BLOCKED`, `RATE_LIMIT_EXCEEDED` is not logged separately — it's a thrown
`IdentityApplicationError`, visible via the standard error response). Grep by `event` name; no centralized
log aggregation is configured by this repository (bring your own — CloudWatch, Datadog, Loki, etc.).

## Metrics you can pull today without new infrastructure

- `GET /observability/metrics` — executions-over-time, failures-by-employee, error fingerprints
- `QueueHealthService.snapshot()` — queue depth/latency
- `BillingService.summary()` — credits used/remaining per org
- `EntitlementService.getUsage()` — current consumption against plan limits, per feature key

No external metrics backend (Prometheus/Datadog) is wired up — `OTEL_ENABLED=true` exports spans via OTLP
if you have a collector, but nothing is required to run the app.
